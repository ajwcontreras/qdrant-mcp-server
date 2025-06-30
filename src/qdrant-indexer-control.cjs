#!/usr/bin/env node

/**
 * Control script for Qdrant background indexer
 */

const fs = require('fs');
const { spawn, execSync } = require('child_process');
const path = require('path');
const readline = require('readline');

const STATE_FILES = {
  PID: '.qdrant-indexer.pid',
  LOG: '.qdrant-indexer.log',
  STATUS: '.qdrant-indexing-status.json'
};

const INDEXER_SCRIPT = path.join(__dirname, 'qdrant-background-indexer.cjs');

class QdrantIndexerControl {
  constructor() {
    this.command = process.argv[2] || 'help';
  }

  async run() {
    switch (this.command) {
      case 'start':
        await this.start();
        break;
      case 'stop':
        await this.stop();
        break;
      case 'restart':
        await this.restart();
        break;
      case 'status':
        await this.status();
        break;
      case 'pause':
        await this.sendCommand('pause');
        break;
      case 'resume':
        await this.sendCommand('resume');
        break;
      case 'reindex':
        await this.reindex();
        break;
      case 'clear':
        await this.clear();
        break;
      case 'logs':
        await this.logs();
        break;
      case 'watch':
        await this.watch();
        break;
      case 'help':
      default:
        this.help();
    }
  }

  async start() {
    if (this.isRunning()) {
      console.log('✓ Indexer is already running');
      return;
    }

    console.log('Starting Qdrant background indexer...');
    
    // Start indexer in background
    const child = spawn('node', [INDEXER_SCRIPT], {
      detached: true,
      stdio: 'ignore',
      cwd: process.cwd()
    });

    child.unref();

    // Wait a moment for startup
    await new Promise(resolve => setTimeout(resolve, 2000));

    if (this.isRunning()) {
      console.log('✓ Indexer started successfully');
      await this.status();
    } else {
      console.error('✗ Failed to start indexer');
      console.log('Check logs: tail -f .qdrant-indexer.log');
    }
  }

  async stop() {
    const pid = this.getPid();
    if (!pid) {
      console.log('✓ Indexer is not running');
      return;
    }

    console.log('Stopping Qdrant background indexer...');
    
    try {
      process.kill(pid, 'SIGTERM');
      
      // Wait for process to stop
      let stopped = false;
      for (let i = 0; i < 10; i++) {
        await new Promise(resolve => setTimeout(resolve, 500));
        if (!this.isRunning()) {
          stopped = true;
          break;
        }
      }

      if (stopped) {
        console.log('✓ Indexer stopped successfully');
      } else {
        console.log('⚠ Indexer is taking longer to stop, sending SIGKILL...');
        process.kill(pid, 'SIGKILL');
      }
    } catch (error) {
      console.error('✗ Failed to stop indexer:', error.message);
    }
  }

  async restart() {
    await this.stop();
    await new Promise(resolve => setTimeout(resolve, 1000));
    await this.start();
  }

  async status() {
    const isRunning = this.isRunning();
    const pid = this.getPid();
    
    console.log('\n=== Qdrant Indexer Status ===');
    console.log(`Status: ${isRunning ? '🟢 Running' : '🔴 Stopped'}`);
    if (pid) console.log(`PID: ${pid}`);

    // Read status file
    if (fs.existsSync(STATE_FILES.STATUS)) {
      try {
        const status = JSON.parse(fs.readFileSync(STATE_FILES.STATUS, 'utf8'));
        
        console.log(`\nStatistics:`);
        console.log(`  Total files: ${status.totalFiles || 0}`);
        console.log(`  Indexed: ${status.indexedCount || 0}`);
        console.log(`  Failed: ${status.failedCount || 0}`);
        console.log(`  Queue size: ${status.queueSize || 0}`);
        console.log(`  Paused: ${status.isPaused ? 'Yes' : 'No'}`);
        
        if (status.uptime) {
          const hours = Math.floor(status.uptime / 3600000);
          const minutes = Math.floor((status.uptime % 3600000) / 60000);
          console.log(`  Uptime: ${hours}h ${minutes}m`);
        }

        if (status.lastActivityTime) {
          const lastActivity = new Date(status.lastActivityTime);
          console.log(`  Last activity: ${lastActivity.toLocaleString()}`);
        }

        // Progress bar
        if (status.totalFiles > 0) {
          const progress = Math.round((status.indexedCount / status.totalFiles) * 100);
          const barLength = 30;
          const filled = Math.round((progress / 100) * barLength);
          const bar = '█'.repeat(filled) + '░'.repeat(barLength - filled);
          console.log(`\nProgress: [${bar}] ${progress}%`);
        }
      } catch (error) {
        console.error('Failed to read status:', error.message);
      }
    }
  }

  async sendCommand(command) {
    const pid = this.getPid();
    if (!pid) {
      console.error('✗ Indexer is not running');
      return;
    }

    console.log(`Sending ${command} command...`);
    
    // For now, we'll need to implement IPC or use signals
    // This is a simplified version
    const child = spawn('node', [INDEXER_SCRIPT, command], {
      stdio: 'inherit'
    });

    child.on('close', (code) => {
      if (code === 0) {
        console.log(`✓ Command '${command}' executed successfully`);
      } else {
        console.error(`✗ Command '${command}' failed`);
      }
    });
  }

  async reindex() {
    console.log('Starting full reindex...');
    console.log('This will clear all indexed data and re-index all files.');
    
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    const answer = await new Promise(resolve => {
      rl.question('Are you sure? (y/N) ', resolve);
    });
    rl.close();

    if (answer.toLowerCase() !== 'y') {
      console.log('Cancelled');
      return;
    }

    await this.sendCommand('reindex');
  }

  async clear() {
    console.log('⚠️  This will clear all indexer data!');
    
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    const answer = await new Promise(resolve => {
      rl.question('Are you sure? (y/N) ', resolve);
    });
    rl.close();

    if (answer.toLowerCase() !== 'y') {
      console.log('Cancelled');
      return;
    }

    await this.stop();
    
    // Remove state files
    Object.values(STATE_FILES).forEach(file => {
      try {
        fs.unlinkSync(file);
        console.log(`✓ Removed ${file}`);
      } catch (e) {}
    });

    // Also remove other state files
    const otherFiles = ['.qdrant-indexing-queue.json', '.qdrant-indexed-files.json'];
    otherFiles.forEach(file => {
      try {
        fs.unlinkSync(file);
        console.log(`✓ Removed ${file}`);
      } catch (e) {}
    });

    console.log('✓ All indexer data cleared');
  }

  async logs() {
    if (!fs.existsSync(STATE_FILES.LOG)) {
      console.log('No log file found');
      return;
    }

    console.log('Tailing logs (Ctrl+C to stop)...\n');
    
    const tail = spawn('tail', ['-f', STATE_FILES.LOG], {
      stdio: 'inherit'
    });

    process.on('SIGINT', () => {
      tail.kill();
      process.exit(0);
    });
  }

  async watch() {
    console.log('Watching indexer status (Ctrl+C to stop)...\n');
    
    // Clear screen
    console.clear();

    const update = async () => {
      // Move cursor to top
      process.stdout.write('\u001b[H');
      
      await this.status();
      
      // Show recent log entries
      if (fs.existsSync(STATE_FILES.LOG)) {
        console.log('\n=== Recent Activity ===');
        try {
          const logs = execSync(`tail -n 5 ${STATE_FILES.LOG}`).toString();
          console.log(logs);
        } catch (e) {}
      }
    };

    // Initial update
    await update();

    // Update every 2 seconds
    const interval = setInterval(update, 2000);

    process.on('SIGINT', () => {
      clearInterval(interval);
      console.log('\n\nStopped watching');
      process.exit(0);
    });
  }

  isRunning() {
    const pid = this.getPid();
    if (!pid) return false;

    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      // Process not running
      return false;
    }
  }

  getPid() {
    try {
      if (fs.existsSync(STATE_FILES.PID)) {
        return parseInt(fs.readFileSync(STATE_FILES.PID, 'utf8'));
      }
    } catch (e) {}
    return null;
  }

  help() {
    console.log(`
Qdrant Indexer Control

Usage: node ${path.basename(__filename)} <command>

Commands:
  start     Start the background indexer
  stop      Stop the background indexer
  restart   Restart the background indexer
  status    Show indexer status
  pause     Pause indexing (keeps monitoring)
  resume    Resume indexing
  reindex   Clear and re-index all files
  clear     Clear all indexer data
  logs      Tail indexer logs
  watch     Watch live status
  help      Show this help

NPM Scripts:
  npm run qdrant:start    Start indexer
  npm run qdrant:stop     Stop indexer
  npm run qdrant:status   Check status
  npm run qdrant:watch    Watch live status
`);
  }
}

// Run controller
const controller = new QdrantIndexerControl();
controller.run().catch(error => {
  console.error('Error:', error);
  process.exit(1);
});