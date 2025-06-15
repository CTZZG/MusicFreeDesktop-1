#!/usr/bin/env node

// scripts/manual-install-mpv.js (CommonJS Version, v2)
const MPVInstaller = require('./install-mpv.js');

async function main() {
    const installer = new MPVInstaller();
    await installer._init(); // 手动调用异步初始化
    const chalk = installer.chalk;

    console.log(chalk.blue.bold('🎵 Manual MPV Installation for MusicFree Desktop\n'));
    const success = await installer.install();
    if (success) {
        console.log(chalk.green('\n🎉 MPV installation completed successfully!'));
    } else {
        console.log(chalk.red('\n❌ MPV installation failed. Please check the logs above.'));
        process.exit(1);
    }
}

main().catch(async (error) => {
    const chalk = (await import('chalk')).default;
    console.error(chalk.red('Fatal error:'), error);
    process.exit(1);
});