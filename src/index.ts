import { MahjongWebSocketServer } from './server/websocket-server.js';
import { loadRuleConfig, getDefaultRuleConfigPath } from './config/rule-config.js';

/**
 * Main entry point for riichi mahjong server
 */

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 8080;

function main() {
  console.log('Starting Riichi Mahjong Server...');

  // Load and validate rules configuration
  try {
    const configPath = getDefaultRuleConfigPath();
    const rules = loadRuleConfig(configPath);

    console.log('Rule configuration loaded successfully:');
    console.log(`  - Variant: ${rules.variant}`);
    console.log(`  - Multiple Ron: ${rules.multipleRon.mode}`);
    console.log(`  - Kiriage Mangan: ${rules.scoring.kiriageMangan}`);
    console.log(`  - Kazoe Yakuman: ${rules.scoring.kazoeYakuman}`);
    console.log(`  - Pao: ${rules.pao.enabled ? 'enabled' : 'disabled'}`);
    console.log(`  - Nagashi Mangan: ${rules.nagashiMangan.enabled ? 'enabled' : 'disabled'}`);

    // Start WebSocket server
    const server = new MahjongWebSocketServer(PORT);

    console.log(`\nServer is running on ws://localhost:${PORT}`);
    console.log('Waiting for connections...\n');

    // Handle graceful shutdown
    process.on('SIGINT', async () => {
      console.log('\nShutting down server...');
      await server.close();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      console.log('\nShutting down server...');
      await server.close();
      process.exit(0);
    });

  } catch (error) {
    console.error('Failed to start server:');
    if (error instanceof Error) {
      console.error(error.message);
    } else {
      console.error(error);
    }
    process.exit(1);
  }
}

// Run server
main();
