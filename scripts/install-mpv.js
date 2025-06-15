const { spawn } = require('child_process');
const os = require('os');

class MPVInstaller {
    constructor() {
        this.platform = os.platform();
        this.arch = os.arch();
        this.chalk = null;
        this.ora = null;
        this.which = null;
    }

    async _init() {
        if (this.chalk) return;
        this.chalk = (await import('chalk')).default;
        this.ora = (await import('ora')).default;
        this.which = (await import('which')).default;
    }

    async checkMPVInstalled() {
        await this._init();
        try {
            await this.which('mpv');
            return true;
        } catch (error) {
            return false;
        }
    }

    async checkPackageManager() {
        await this._init();
        const managers = {
            winget: 'winget', choco: 'choco', scoop: 'scoop',
            brew: 'brew', apt: 'apt-get', dnf: 'dnf', yum: 'yum', pacman: 'pacman'
        };
        for (const [name, command] of Object.entries(managers)) {
            try {
                if (this.platform === 'win32' && !['winget', 'choco', 'scoop'].includes(name)) continue;
                if (this.platform === 'darwin' && name !== 'brew') continue;
                if (this.platform === 'linux' && ['winget', 'choco', 'scoop', 'brew'].includes(name)) continue;
                
                await this.which(command);
                return name;
            } catch (error) { continue; }
        }
        return null;
    }

    _spawnPromise(command, args, options = {}) {
        return new Promise((resolve, reject) => {
            const child = spawn(command, args, { stdio: 'inherit', ...options });
            child.on('close', code => code === 0 ? resolve() : reject(new Error(`Process failed with code ${code}`)));
            child.on('error', reject);
        });
    }

    async installMPVLinux(packageManager) {
        await this._init();
        const commands = {
            apt: 'sudo apt-get update && sudo apt-get install -y mpv',
            dnf: 'sudo dnf install -y mpv',
            yum: 'sudo yum install -y mpv',
            pacman: 'sudo pacman -S --noconfirm mpv'
        };
        console.log(this.chalk.yellow(`Installing MPV using ${packageManager}...`));
        return this._spawnPromise('sh', ['-c', commands[packageManager]]);
    }

    async installMPVMacOS(packageManager) {
        await this._init();
        console.log(this.chalk.yellow('Installing MPV using Homebrew...'));
        return this._spawnPromise('sh', ['-c', 'brew install mpv']);
    }

    async installMPVWindows(packageManager) {
        await this._init();
        const commands = {
            choco: 'choco install mpv -y',
            scoop: 'scoop install mpv',
            winget: 'winget install --id=mpv-player.mpv -e'
        };
        console.log(this.chalk.yellow(`Installing MPV using ${packageManager}...`));
        return this._spawnPromise('cmd.exe', ['/c', commands[packageManager]]);
    }

    async install() {
        await this._init();
        const spinner = this.ora('Checking MPV installation...').start();
        try {
            if (await this.checkMPVInstalled()) {
                spinner.succeed(this.chalk.green('MPV is already installed!'));
                return true;
            }
            spinner.text = 'MPV not found. Checking package managers...';
            const packageManager = await this.checkPackageManager();
            if (!packageManager) {
                spinner.fail(this.chalk.red('No supported package manager found!'));
                this.printManualInstructions();
                return false;
            }
            spinner.succeed(this.chalk.yellow(`Found package manager: ${packageManager}`));
            console.log(this.chalk.blue.bold('\n🎵 Installing MPV Media Player...'));
            if (this.platform === 'win32') await this.installMPVWindows(packageManager);
            else if (this.platform === 'darwin') await this.installMPVMacOS(packageManager);
            else await this.installMPVLinux(packageManager);
            
            spinner.succeed(this.chalk.green('MPV installation command completed successfully!'));
            console.log(this.chalk.yellow('\nIMPORTANT: Please close and reopen your terminal for the changes to take effect.'));
            console.log(this.chalk.gray('After reopening, you can run "pnpm run install-mpv" again to verify.'));
            return true;
        } catch (error) {
            spinner.fail(this.chalk.red('Installation failed!'));
            console.error(this.chalk.red('Error:'), error.message);
            this.printManualInstructions();
            return false;
        }
    }

    printManualInstructions() {
        if (!this.chalk) {
            console.log('\n[Manual Installation Required]');
            console.log('Please see https://mpv.io/installation/ for instructions.');
            return;
        }
        const chalk = this.chalk;
        console.log(chalk.yellow.bold('\n📋 Manual Installation Required'));
        console.log(chalk.white('Please install MPV manually using the appropriate method for your system:\n'));
    
        if (this.platform === 'win32') {
          console.log(chalk.cyan('Windows:'));
          console.log(chalk.white('• Chocolatey: ') + chalk.gray('choco install mpv'));
          console.log(chalk.white('• Scoop: ') + chalk.gray('scoop install mpv'));
          console.log(chalk.white('• Winget: ') + chalk.gray('winget install mpv-player.mpv'));
          console.log(chalk.white('• Manual: ') + chalk.gray('Download from https://mpv.io/installation/'));
        } else if (this.platform === 'darwin') {
          console.log(chalk.cyan('macOS:'));
          console.log(chalk.white('• Homebrew: ') + chalk.gray('brew install mpv'));
          console.log(chalk.white('• MacPorts: ') + chalk.gray('sudo port install mpv'));
        } else {
          console.log(chalk.cyan('Linux:'));
          console.log(chalk.white('• Ubuntu/Debian: ') + chalk.gray('sudo apt-get install mpv'));
          console.log(chalk.white('• Fedora/RHEL: ') + chalk.gray('sudo dnf install mpv'));
          console.log(chalk.white('• Arch Linux: ') + chalk.gray('sudo pacman -S mpv'));
        }
    
        console.log(chalk.gray('\nAfter installation, run the music player again.'));
      }
}

module.exports = MPVInstaller;

if (require.main === module) {
    (async () => {
        const installer = new MPVInstaller();
        await installer._init();
        const chalk = installer.chalk;
        
        console.log(chalk.blue.bold('🎵 MusicFree Desktop - MPV Setup\n'));
        await installer.install().catch(err => {
            console.error(chalk.red('An error occurred during MPV installation:'), err);
            process.exit(1);
        });
    })();
}