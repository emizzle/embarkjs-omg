import { embarkPath, dappPath } from "embark-utils";
import { BigNumber } from "ethers/utils";
import ChildChain from "@omisego/omg-js-childchain";
import RootChain from "@omisego/omg-js-rootchain";
import { transaction } from "@omisego/omg-js-util";

// const WEB3_PROVIDER_URL = "https://rinkeby.infura.io/";
// const WATCHER_URL = "https://watcher.ari.omg.network/";
// const CHILDCHAIN_URL = "https://ari.omg.network/";
// const PLASMA_CONTRACT_ADDRESS = "0x44de0ec539b8c4a4b530c78620fe8320167f2f74";

// Service check constants
const SERVICE_CHECK_ON = 'on';
const SERVICE_CHECK_OFF = 'off';


// var web3 = new Web3()
let globalKeystore;
let rootChain;
let childChain;

const ADDRESS = "0x1e8df8b7d4212084bf5329fddc730b9e5aaba238";
const ADDRESS_PK = "0x0f7aa58edd2758334a819516b3421953b6c453c3e8ed85b071ce1edf3aedfab8";

/**
 * Plugin that connects an Embark dApp to the Status app, and allows the dApp
 * to be run in the Status browser.
 */
class EmbarkOmg {
  constructor(embark) {
    this.embark = embark;
    this.events = this.embark.events;
    this.pluginConfig = this.embark.pluginConfig;
    this.deviceIp = this.pluginConfig.deviceIp;
    this.logger = this.embark.logger;
    this.fs = embark.fs;

    // plugin opts
    this.plasmaContractAddress = this.pluginConfig.PLASMA_CONTRACT_ADDRESS;
    this.web3ProviderUrl = this.pluginConfig.WEB3_PROVIDER_URL;
    this.watcherUrl = this.pluginConfig.WATCHER_URL;
    this.childChainUrl = this.pluginConfig.CHILDCHAIN_URL;



    this.webServerConfig = {};
    this.blockchainConfig = {};

    // gets hydrated webserver config from embark
    this.events.on('config:load:webserver', webServerConfig => {
      this.webServerConfig = webServerConfig;
    });

    // gets hydrated blockchain config from embark
    this.events.on('config:load:blockchain', blockchainConfig => {
      this.blockchainConfig = blockchainConfig;
    });

    // register service check
    //this._registerServiceCheck();

    this.init();

  }

  async txChildChain() {
    const val = "555";
    const toAddress = "0x38d5beb778b6e62d82e3ba4633e08987e6d0f990";
    const utxos = await this.childChain.getUtxos(ADDRESS);
    const utxosToSpend = this.selectUtxos(utxos, val, transaction.ETH_CURRENCY);
    if (!utxosToSpend) {
      return console.error(`No utxo big enough to cover the amount ${val}`);
    }

    const txBody = {
      inputs: utxosToSpend,
      outputs: [{
        owner: toAddress,
        currency: transaction.ETH_CURRENCY,
        amount: Number(val)
      }]
    };

    if (utxosToSpend[0].amount > val) {
      // specify the change amount back to yourself
      const CHANGE_AMOUNT = utxosToSpend[0].amount - val;
      txBody.outputs.push({
        owner: ADDRESS,
        currency: transaction.ETH_CURRENCY,
        amount: CHANGE_AMOUNT
      });
    }

    try {
      const unsignedTx = await this.childChain.createTransaction(txBody);

      const signatures = await this.childChain.signTransaction(unsignedTx, [ADDRESS_PK]);

      const signedTx = await this.childChain.buildSignedTransaction(unsignedTx, signatures);

      const result = await this.childChain.submitTransaction(signedTx);

      console.log(`Submitted tx: ${JSON.stringify(result)}`);
    }
    catch (e) {
      console.error(e);
    }
  }

  async deposit() {
    const DEPOSIT_AMT = "100000";

    const depositTx = transaction.encodeDeposit(ADDRESS, DEPOSIT_AMT, transaction.ETH_CURRENCY);
    try {
      const receipt = await this.rootChain.depositEth(depositTx, DEPOSIT_AMT, { from: ADDRESS, privateKey: ADDRESS_PK });
      console.log(receipt);
    }
    catch (e) {
      console.log(e);
    }
  }

  async init() {
    let web3Location = await this.getWeb3Location();
    web3Location = web3Location.replace(/\\/g, '/');

    const Web3 = require(web3Location);

    this.web3 = new Web3;

    const web3Provider = new Web3.providers.HttpProvider(this.web3ProviderUrl);
    this.web3.setProvider(web3Provider);

    this.rootChain = new RootChain(this.web3, this.plasmaContractAddress);
    this.childChain = new ChildChain(this.watcherUrl, this.childChainUrl);

    await this.deposit();
    await this.txChildChain();
  }

  selectUtxos(utxos, amount, currency) {
    const correctCurrency = utxos.filter(utxo => utxo.currency === currency)
    // Just find the first utxo that can fulfill the amount
    const selected = correctCurrency.find(utxo => new BigNumber(utxo.amount).gte(new BigNumber(amount)));
    if (selected) {
      return [selected];
    }
  }

  getWeb3Location() {
    return new Promise((resolve, reject) => {
      this.events.request("version:get:web3", (web3Version) => {
        if (web3Version === "1.0.0-beta") {
          const nodePath = embarkPath('node_modules');
          const web3Path = require.resolve("web3", { paths: [nodePath] });
          return resolve(web3Path);
        }
        this.events.request("version:getPackageLocation", "web3", web3Version, (err, location) => {
          if (err) {
            return reject(err);
          }
          const locationPath = embarkPath(location);
          resolve(locationPath);
        });
      });
    });
  }

  /**
   * Registers this plugin for Embark service checks and sets up log messages for
   * connection and disconnection events. The service check pings the Status app.
   * 
   * @returns {void}
   */
  _registerServiceCheck() {
    // const serviceCheckQueue = queue((task, callback) => {
    //   this.statusApi.ping((err, isOnline) => {
    //     if (!err && isOnline) this.events.emit('embark-status:connect');
    //     const stateName = (isOnline ? SERVICE_CHECK_ON : SERVICE_CHECK_OFF);
    //     task.cb({ name: `Status.im (${this.deviceIp})`, status: stateName });
    //   });
    //   callback();
    // }, 1);
    this.embark.registerServiceCheck('OmiseGO', (cb) => {
      //serviceCheckQueue.push({ cb });
      cb({ name: `OmiseGO network (${this.deviceIp})`, status: SERVICE_CHECK_ON });
    });

    this.embark.events.on('check:backOnline:OmiseGO', () => {
      this.logger.info("------------------");
      this.logger.info("Connected to the OmiseGO network!");
      this.logger.info("------------------");
    });

    this.embark.events.on('check:wentOffline:OmiseGO', () => {
      this.logger.error("------------------");
      this.logger.error("Couldn't connect or lost connection to the OmiseGO network...");
      this.logger.error("------------------");
    });
  }
}

export default EmbarkOmg;
