#!/usr/bin/env node

/**
 * Background indexer for Qdrant - monitors file changes and indexes them automatically
 */

const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');
const { spawn } = require('child_process');

// Configuration
const CONFIG = {
  BATCH_SIZE: 10,
  BATCH_DELAY: 2000,
  DEBOUNCE_DELAY: 500,
  MAX_RETRIES: 3,
  RETRY_DELAY: 5000,
  MAX_FILE_SIZE: 1024 * 1024, // 1MB
  STATE_FILES: {
    PID: '.qdrant-indexer.pid',
    LOG: '.qdrant-indexer.log',
    QUEUE: '.qdrant-indexing-queue.json',
    INDEXED: '.qdrant-indexed-files.json',
    STATUS: '.qdrant-indexing-status.json'
  }
};

// File patterns
const INCLUDE_PATTERNS = [
  '**/*.ts',
  '**/*.tsx',
  '**/*.js',
  '**/*.jsx',
  '**/*.json',
  '**/*.prisma',
  '**/*.md',
  '**/*.css'
];

const EXCLUDE_PATTERNS = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/coverage/**',
  '**/.next/**',
  '**/*.test.*',
  '**/*.spec.*',
  '**/__tests__/**',
  '**/.env*',
  '**/tmp/**',
  '**/*.log',
  '**/.qdrant-*',
  '**/qdrant_storage/**'
];

class QdrantBackgroundIndexer {
  constructor() {
    this.queue = [];
    this.indexedFiles = new Set();
    this.failedFiles = new Map();
    this.isProcessing = false;
    this.isPaused = false;
    this.stats = {
      totalFiles: 0,
      indexedCount: 0,
      failedCount: 0,
      queueSize: 0,
      startTime: Date.now(),
      lastActivityTime: Date.now()
    };
    this.debounceTimers = new Map();
    this.watcher = null;
  }

  async start() {
    try {
      // Check if already running
      if (this.isRunning()) {
        console.log('Indexer is already running');
        return;
      }

      // Write PID file
      fs.writeFileSync(CONFIG.STATE_FILES.PID, process.pid.toString());

      // Load state
      await this.loadState();

      // Setup logging
      this.setupLogging();

      // Start file watcher
      await this.startWatcher();

      // Start processing queue
      this.startProcessing();

      // Setup graceful shutdown
      this.setupShutdown();

      this.log('info', 'Background indexer started');
      console.log('Background indexer started (PID: ' + process.pid + ')');

      // Keep process alive
      setInterval(() => {
        this.updateStatus();
      }, 5000);

    } catch (error) {
      this.log('error', 'Failed to start indexer: ' + error.message);
      console.error('Failed to start:', error);
      process.exit(1);
    }
  }

  isRunning() {
    try {
      if (fs.existsSync(CONFIG.STATE_FILES.PID)) {
        const pid = parseInt(fs.readFileSync(CONFIG.STATE_FILES.PID, 'utf8'));
        // Check if process is running
        process.kill(pid, 0);
        return true;
      }
    } catch (e) {
      // Process not running
    }
    return false;
  }

  setupLogging() {
    this.logStream = fs.createWriteStream(CONFIG.STATE_FILES.LOG, { flags: 'a' });
  }

  log(level, message) {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] [${level.toUpperCase()}] ${message}\n`;
    
    if (this.logStream) {
      this.logStream.write(logEntry);
    }
    
    if (level === 'error') {
      console.error(logEntry);
    }
  }

  async loadState() {
    // Load indexed files
    if (fs.existsSync(CONFIG.STATE_FILES.INDEXED)) {
      try {
        const data = JSON.parse(fs.readFileSync(CONFIG.STATE_FILES.INDEXED, 'utf8'));
        this.indexedFiles = new Set(data.files || []);
        this.log('info', `Loaded ${this.indexedFiles.size} indexed files`);
      } catch (e) {
        this.log('error', 'Failed to load indexed files: ' + e.message);
      }
    }

    // Load queue
    if (fs.existsSync(CONFIG.STATE_FILES.QUEUE)) {
      try {
        const data = JSON.parse(fs.readFileSync(CONFIG.STATE_FILES.QUEUE, 'utf8'));
        this.queue = data.queue || [];
        this.log('info', `Loaded ${this.queue.length} queued files`);
      } catch (e) {
        this.log('error', 'Failed to load queue: ' + e.message);
      }
    }

    // Load status
    if (fs.existsSync(CONFIG.STATE_FILES.STATUS)) {
      try {
        const data = JSON.parse(fs.readFileSync(CONFIG.STATE_FILES.STATUS, 'utf8'));
        this.stats = { ...this.stats, ...data };
      } catch (e) {
        this.log('error', 'Failed to load status: ' + e.message);
      }
    }
  }

  saveState() {
    try {
      // Save indexed files
      fs.writeFileSync(CONFIG.STATE_FILES.INDEXED, JSON.stringify({
        files: Array.from(this.indexedFiles),
        lastUpdated: new Date().toISOString()
      }, null, 2));

      // Save queue
      fs.writeFileSync(CONFIG.STATE_FILES.QUEUE, JSON.stringify({
        queue: this.queue,
        lastUpdated: new Date().toISOString()
      }, null, 2));

      // Save status
      this.updateStatus();
    } catch (e) {
      this.log('error', 'Failed to save state: ' + e.message);
    }
  }

  updateStatus() {
    const status = {
      ...this.stats,
      queueSize: this.queue.length,
      indexedCount: this.indexedFiles.size,
      failedCount: this.failedFiles.size,
      isProcessing: this.isProcessing,
      isPaused: this.isPaused,
      uptime: Date.now() - this.stats.startTime,
      lastActivityTime: this.stats.lastActivityTime,
      pid: process.pid
    };

    try {
      fs.writeFileSync(CONFIG.STATE_FILES.STATUS, JSON.stringify(status, null, 2));
    } catch (e) {
      this.log('error', 'Failed to update status: ' + e.message);
    }
  }

  async startWatcher() {
    this.log('info', 'Starting file watcher');

    // Count total files first
    const countFiles = (dir) => {
      let count = 0;
      const items = fs.readdirSync(dir, { withFileTypes: true });
      
      for (const item of items) {
        const fullPath = path.join(dir, item.name);
        
        // Skip excluded patterns
        if (EXCLUDE_PATTERNS.some(pattern => {
          const regex = new RegExp(pattern.replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*'));
          return regex.test(fullPath);
        })) continue;

        if (item.isDirectory()) {
          count += countFiles(fullPath);
        } else if (item.isFile() && this.shouldIncludeFile(fullPath)) {
          count++;
        }
      }
      return count;
    };

    try {
      this.stats.totalFiles = countFiles(process.cwd());
      this.log('info', `Found ${this.stats.totalFiles} files to monitor`);
    } catch (e) {
      this.log('error', 'Failed to count files: ' + e.message);
    }

    // Create watcher
    this.watcher = chokidar.watch(INCLUDE_PATTERNS, {
      ignored: EXCLUDE_PATTERNS,
      persistent: true,
      ignoreInitial: true, // Don't index everything on startup
      cwd: process.cwd()
    });

    // Handle events
    this.watcher
      .on('add', path => this.handleFileChange('add', path))
      .on('change', path => this.handleFileChange('change', path))
      .on('unlink', path => this.handleFileRemove(path))
      .on('error', error => this.log('error', 'Watcher error: ' + error.message));

    // Wait for initial scan
    await new Promise(resolve => {
      this.watcher.on('ready', () => {
        this.log('info', 'File watcher ready');
        resolve();
      });
    });
  }

  shouldIncludeFile(filePath) {
    // Check file size
    try {
      const stats = fs.statSync(filePath);
      if (stats.size > CONFIG.MAX_FILE_SIZE) {
        return false;
      }
    } catch (e) {
      return false;
    }

    // Check include patterns
    return INCLUDE_PATTERNS.some(pattern => {
      const regex = new RegExp(pattern.replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*'));
      return regex.test(filePath);
    });
  }

  handleFileChange(event, filePath) {
    const absPath = path.resolve(filePath);

    // Clear existing debounce timer
    if (this.debounceTimers.has(absPath)) {
      clearTimeout(this.debounceTimers.get(absPath));
    }

    // Set new debounce timer
    const timer = setTimeout(() => {
      this.debounceTimers.delete(absPath);
      
      if (!this.indexedFiles.has(absPath) || event === 'change') {
        this.addToQueue(absPath);
        this.log('info', `File ${event}: ${filePath}`);
      }
    }, CONFIG.DEBOUNCE_DELAY);

    this.debounceTimers.set(absPath, timer);
  }

  handleFileRemove(filePath) {
    const absPath = path.resolve(filePath);
    
    // Remove from indexed files
    if (this.indexedFiles.has(absPath)) {
      this.indexedFiles.delete(absPath);
      this.log('info', `File removed: ${filePath}`);
      this.saveState();
    }

    // Remove from queue
    this.queue = this.queue.filter(item => item.path !== absPath);
  }

  addToQueue(filePath) {
    const absPath = path.resolve(filePath);
    
    // Check if already in queue
    if (this.queue.some(item => item.path === absPath)) {
      return;
    }

    // Add to queue
    this.queue.push({
      path: absPath,
      addedAt: Date.now(),
      retries: 0
    });

    this.stats.lastActivityTime = Date.now();
    this.saveState();
  }

  async startProcessing() {
    this.log('info', 'Starting queue processor');
    
    // Don't block the event loop
    setImmediate(async () => {
      while (true) {
        try {
          if (!this.isPaused && this.queue.length > 0 && !this.isProcessing) {
            this.log('info', `Queue has ${this.queue.length} files, starting batch processing`);
            await this.processBatch();
          }
          
          // Wait before next batch
          await new Promise(resolve => setTimeout(resolve, CONFIG.BATCH_DELAY));
        } catch (error) {
          this.log('error', `Error in processing loop: ${error.message}`);
        }
      }
    });
  }

  async processBatch() {
    this.isProcessing = true;
    
    // Get batch of files
    const batch = this.queue.splice(0, CONFIG.BATCH_SIZE);
    
    this.log('info', `Processing batch of ${batch.length} files`);

    for (const item of batch) {
      try {
        await this.indexFile(item.path);
        this.indexedFiles.add(item.path);
        this.stats.indexedCount++;
      } catch (error) {
        this.log('error', `Failed to index ${item.path}: ${error.message}`);
        
        item.retries++;
        if (item.retries < CONFIG.MAX_RETRIES) {
          // Re-add to queue
          setTimeout(() => {
            this.queue.push(item);
          }, CONFIG.RETRY_DELAY);
        } else {
          // Mark as failed
          this.failedFiles.set(item.path, {
            error: error.message,
            failedAt: Date.now()
          });
          this.stats.failedCount++;
        }
      }
    }

    this.stats.lastActivityTime = Date.now();
    this.saveState();
    this.isProcessing = false;
  }

  async indexFile(filePath) {
    // Use the Python indexer
    return new Promise((resolve, reject) => {
      const scriptPath = path.join(__dirname, 'qdrant-openai-indexer.py');
      
      const child = spawn('python3', [scriptPath, '--file', filePath], {
        cwd: process.cwd(),
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'] // Ignore stdin, pipe stdout/stderr
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', data => stdout += data);
      child.stderr.on('data', data => stderr += data);

      child.on('close', code => {
        if (code === 0) {
          this.log('info', `Successfully indexed: ${path.basename(filePath)}`);
          resolve();
        } else {
          const errorMsg = stderr || stdout || `Process exited with code ${code}`;
          reject(new Error(errorMsg));
        }
      });

      child.on('error', (error) => {
        reject(new Error(`Failed to spawn indexer: ${error.message}`));
      });
    });
  }

  pause() {
    this.isPaused = true;
    this.log('info', 'Indexer paused');
    this.updateStatus();
  }

  resume() {
    this.isPaused = false;
    this.log('info', 'Indexer resumed');
    this.updateStatus();
  }

  async stop() {
    this.log('info', 'Stopping indexer');
    
    // Stop watcher
    if (this.watcher) {
      await this.watcher.close();
    }

    // Clear timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }

    // Save final state
    this.saveState();

    // Close log stream
    if (this.logStream) {
      this.logStream.end();
    }

    // Remove PID file
    try {
      fs.unlinkSync(CONFIG.STATE_FILES.PID);
    } catch (e) {}

    process.exit(0);
  }

  setupShutdown() {
    const shutdown = () => this.stop();
    
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    process.on('SIGHUP', shutdown);
    
    process.on('uncaughtException', (error) => {
      this.log('error', 'Uncaught exception: ' + error.message);
      shutdown();
    });
  }

  async reindex() {
    this.log('info', 'Starting full reindex');
    
    // Clear indexed files
    this.indexedFiles.clear();
    this.failedFiles.clear();
    this.queue = [];
    
    // Save cleared state
    this.saveState();
    
    // Restart watcher (will re-add all files)
    if (this.watcher) {
      await this.watcher.close();
    }
    await this.startWatcher();
  }

  clearAll() {
    // Remove all state files
    Object.values(CONFIG.STATE_FILES).forEach(file => {
      try {
        fs.unlinkSync(file);
      } catch (e) {}
    });
    
    this.log('info', 'Cleared all indexer data');
  }
}

// Main execution
if (require.main === module) {
  const indexer = new QdrantBackgroundIndexer();
  
  // Handle command line arguments
  const command = process.argv[2];
  
  switch (command) {
    case 'pause':
      indexer.pause();
      break;
    case 'resume':
      indexer.resume();
      break;
    case 'reindex':
      indexer.reindex();
      break;
    case 'clear':
      indexer.clearAll();
      break;
    default:
      indexer.start();
  }
}

module.exports = QdrantBackgroundIndexer;