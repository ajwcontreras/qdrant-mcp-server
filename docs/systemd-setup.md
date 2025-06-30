# Systemd Service for Qdrant Background Indexer

This guide explains how to set up the Qdrant background indexer as a systemd service for automatic startup.

## Installation

### 1. Copy the service file

```bash
sudo cp scripts/qdrant-indexer.service /etc/systemd/system/
```

### 2. Update the service file

Edit the service file to match your environment:

```bash
sudo nano /etc/systemd/system/qdrant-indexer.service
```

Update these values:
- `WorkingDirectory`: Path to your KinDash project
- `ExecStart`: Path to the indexer script
- `User`: Your username
- `Environment`: Adjust paths and API key location

### 3. Set up API key

Option A - Use environment file:
```bash
mkdir -p ~/.config/openai
echo "YOUR_OPENAI_API_KEY" > ~/.config/openai/api_key
chmod 600 ~/.config/openai/api_key
```

Option B - Use systemd environment:
```bash
sudo systemctl edit qdrant-indexer.service
```

Add:
```
[Service]
Environment="OPENAI_API_KEY=your-key-here"
```

### 4. Enable and start the service

```bash
# Reload systemd
sudo systemctl daemon-reload

# Enable service to start on boot
sudo systemctl enable qdrant-indexer.service

# Start the service
sudo systemctl start qdrant-indexer.service

# Check status
sudo systemctl status qdrant-indexer.service
```

## Management

### Service commands

```bash
# Start service
sudo systemctl start qdrant-indexer

# Stop service
sudo systemctl stop qdrant-indexer

# Restart service
sudo systemctl restart qdrant-indexer

# Check status
sudo systemctl status qdrant-indexer

# View logs
sudo journalctl -u qdrant-indexer -f

# Disable auto-start
sudo systemctl disable qdrant-indexer
```

### Using the control script

The npm scripts still work with systemd:

```bash
# Check status
npm run qdrant:status

# Pause indexing
npm run qdrant:indexer pause

# Resume indexing
npm run qdrant:indexer resume

# Watch live status
npm run qdrant:watch
```

## Troubleshooting

### Service won't start

1. Check logs:
   ```bash
   sudo journalctl -u qdrant-indexer -n 50
   ```

2. Verify paths in service file:
   ```bash
   sudo systemctl cat qdrant-indexer
   ```

3. Test manually:
   ```bash
   cd /home/tony/GitHub/KinDash-Main
   node scripts/qdrant-background-indexer.cjs
   ```

### Permission issues

Ensure the user has access to:
- Project directory
- Node.js executable
- OpenAI API key file
- Log file location

### Environment variables

The service uses these environment variables:
- `OPENAI_API_KEY`: Your OpenAI API key
- `QDRANT_URL`: Qdrant server URL (default: http://localhost:6333)
- `COLLECTION_NAME`: Qdrant collection name
- `NODE_ENV`: Node environment (production)

## Security Notes

1. Store API keys securely (use file with 600 permissions)
2. Run service as non-root user
3. Limit file system access to project directory
4. Monitor resource usage

## Alternative: User Service

For development, you can use a user service instead:

```bash
# Create user service directory
mkdir -p ~/.config/systemd/user/

# Copy service file
cp scripts/qdrant-indexer.service ~/.config/systemd/user/

# Edit paths to use full paths (no %h)
nano ~/.config/systemd/user/qdrant-indexer.service

# Enable and start
systemctl --user daemon-reload
systemctl --user enable qdrant-indexer
systemctl --user start qdrant-indexer
systemctl --user status qdrant-indexer
```

This runs the service under your user account without sudo.