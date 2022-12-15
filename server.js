const ethers = require('ethers');
const express = require('express');
const helmet = require('helmet');
const port = process.argv[2] || 3000;
const db = {};

if (!process.env.MAINNET_PROVIDER_URL) {
  console.error('MAINNET_PROVIDER_URL environment variable required. Get a JSON RPC URL for free at infura.io or alchemy.com. Exiting.');
  process.exit(1);
}

// Update borrower data for all Comet instances
// Happens in an interval if not manually updated in between auto-syncs
// const autoSyncInterval = 20 * 60 * 1000; // 20 minutes in ms
const autoSyncInterval = 60 * 60 * 1000;

const cometInstanceData = {
  '1_USDC_0xc3d688B66703497DAA19211EEdff47f25384cdc3': {
    proxy: '0xc3d688B66703497DAA19211EEdff47f25384cdc3',
    rpc: process.env.MAINNET_PROVIDER_URL,
    debounceMs: 90 * 1000,
    baseAssetDecimals: 6,
    baseAssetSymbol: 'USDC',
    baseAssetAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    baseAssetPriceFeed: '0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6',
  },
  // MAINNET_WETH_1: {},
};

const cometAbi = [
  'event Withdraw(address indexed src, address indexed to, uint amount)',
  'function userBasic(address account) public view returns (int104 principal, uint64 baseTrackingIndex, uint64 baseTrackingAccrued, uint16 assetsIn, uint8 _reserved)',
  'function baseToken() public view returns (address)',
  'function baseTokenPriceFeed() public view returns (address)',
  'function numAssets() public view returns (uint8)',
  'function getAssetInfo(uint8 i) public view returns (uint8 offset, address asset, address priceFeed, uint64 scale, uint64 borrowCollateralFactor, uint64 liquidateCollateralFactor, uint64 liquidationFactor, uint128 supplyCap)',
  'function getPrice(address priceFeed) public view returns (uint128)',
  'function borrowBalanceOf(address account) public view returns (uint256)',
  'function collateralBalanceOf(address account, address asset) public view returns (uint128)',
];

const erc20Abi = [
  'function symbol() public view returns(string)',
  'function decimals() public view returns(uint8)',
];

function updateConsoleLogLine() {
  const strings = [];

  Object.values(arguments).forEach(arg => {
    const str = arg.toString();
    strings.push(str === '[object Object]' ? JSON.stringify(arg) : str);
  });

  process.stdout.clearLine();
  process.stdout.cursorTo(0);
  process.stdout.write(strings.join(', '));
}

function decodeAssetsIn(assetsIn, assets) {
  const userCollaterals = [];
  const collaterals = Object.keys(assets);
  collaterals.shift();
  collaterals.forEach((asset, i) => {
    if (((assetsIn & (1 << i)) != 0)) {
      userCollaterals.push(asset);
    }
  });

  return userCollaterals;
}

async function syncDbWithBlockchains() {
  const instances = Object.keys(cometInstanceData);

  for (let i = 0; i < instances.length; i++) {
    const instance = instances[i];

    if (!db[instance]) {
      db[instance] = {
        block: 0,
        ts: 0,
        borrowers: [],
        assets: {},
        numCollaterals: 0,
      };
    }

    const timestamp = Date.now();
    const { debounceMs } = cometInstanceData[instance];

    // Polled too recently, debounce to limit frivolous JSON RPC calls
    if (db[instance].ts + debounceMs > timestamp) {
      return;
    }
    db[instance].ts = timestamp;

    const provider = new ethers.providers.JsonRpcProvider(cometInstanceData[instance].rpc);
    const comet = new ethers.Contract(cometInstanceData[instance].proxy, cometAbi, provider);
    const numCollaterals = await comet.callStatic.numAssets();

    // Update the in-memory DB first then save it to disk

    if (numCollaterals !== db[instance].numCollaterals) {
      db[instance].assets = await pullAssetDataFromChain(instance, db[instance].assets);
    }

    db[instance].numCollaterals = numCollaterals;

    await pullPriceDataFromChain(instance, db[instance].assets);
    await pullBorrowerDataFromChain(instance, db[instance].block);
    calculateAccountHealths(instance);
  }
}

async function pullAssetDataFromChain(instance, assets) {
  const { proxy, rpc, baseAssetDecimals, baseAssetSymbol, baseAssetAddress, baseAssetPriceFeed } = cometInstanceData[instance];

  const provider = new ethers.providers.JsonRpcProvider(rpc);
  const comet = new ethers.Contract(proxy, cometAbi, provider);

  // First asset in this object (keys) is always the base asset
  assets[baseAssetSymbol] = { address: baseAssetAddress, decimals: baseAssetDecimals, priceFeed: baseAssetPriceFeed };

  const numAssets = await comet.callStatic.numAssets();

  for (let i = 0; i < numAssets; i++) {
    const info = await comet.callStatic.getAssetInfo(i);
    const [ address, priceFeed, cf, lcf ] = [ info[1], info[2], +(info[4]).toString() / 1e18, +(info[5]).toString() / 1e18 ];
    const asset = new ethers.Contract(address, erc20Abi, provider);
    const assetSymbol = await asset.callStatic.symbol();
    const decimals = +(await asset.callStatic.decimals()).toString();

    assets[assetSymbol] = { address, decimals, priceFeed, cf, lcf };
  }

  return assets;
}

async function pullPriceDataFromChain(instance, assets) {
  const { proxy, rpc } = cometInstanceData[instance];

  const provider = new ethers.providers.JsonRpcProvider(rpc);
  const comet = new ethers.Contract(proxy, cometAbi, provider);

  const numAssets = Object.keys(assets).length;

  for (let i = 0; i < numAssets; i++) {
    const symbol = Object.keys(assets)[i];
    const { priceFeed } = assets[symbol];
    const price = +(await comet.callStatic.getPrice(priceFeed)).toString() / 1e8;
    db[instance].assets[symbol].price = price;
  }
}

async function pullBorrowerDataFromChain(instance, fromBlock) {
  // Get all hitorical withdraws
  // Narrow it down to all present borrowers based on all the withdraws

  const { proxy, rpc, baseAssetDecimals } = cometInstanceData[instance];

  const provider = new ethers.providers.JsonRpcProvider(rpc);
  const toBlock = await provider.getBlockNumber();

  const comet = new ethers.Contract(proxy, cometAbi, provider);
  const withdrawFilter = comet.filters.Withdraw();

  const withdrawEvents = await comet.queryFilter(withdrawFilter, fromBlock, toBlock);

  const maybeBorrowers = {};

  withdrawEvents.forEach(({ args }) => {
    const [ from, to, amount ] = args;

    if (+amount.toString() > 0) {
      maybeBorrowers[from] = null;
    }
  });

  const prevBorrowers = Object.keys(db[instance].borrowers);
  const accounts = Object.keys(maybeBorrowers).concat(prevBorrowers);
  const borrowers = {};

  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[i];
    updateConsoleLogLine('Getting `userBasic`s of instance:', i, '/', accounts.length, account);
    let ub;
    try {
      ub = await comet.callStatic.userBasic(account);
    } catch(err) {
      console.log(`Get userBasic ${account} Error:`, err);
    }
    if (+ub.principal.toString() < 0) {
      const borrowBalance = +(await comet.callStatic.borrowBalanceOf(account)).toString() / Math.pow(10, baseAssetDecimals);
      borrowers[account] = {
        borrowBalance,
        collaterals: {},
      }
      const assetsIn = decodeAssetsIn(+ub.assetsIn.toString(), db[instance].assets);
      for (let j = 0; j < assetsIn.length; j++) {
        const assetSymbol = assetsIn[j];
        const { price, address, decimals } = db[instance].assets[assetSymbol];
        const balance = +(await comet.callStatic.collateralBalanceOf(account, address)).toString() / Math.pow(10, decimals);
        borrowers[account].collaterals[assetSymbol] = balance;
      }
    }
  }

  updateConsoleLogLine('');

  db[instance].block = toBlock;
  db[instance].borrowers = borrowers;
}

function calculateAccountHealths(instance) {
  const borrowers = Object.keys(db[instance].borrowers);

  borrowers.forEach((account, i) => {
    const borrower = db[instance].borrowers[account];

    const collaterals = Object.keys(borrower.collaterals);
    const borrowBalance = borrower.borrowBalance;
    const basePrice = db[instance].assets[Object.keys(db[instance].assets)[0]].price;
    const borrowValue = borrowBalance * basePrice;

    let borrowLimit = 0;
    let liquidationLimit = 0;

    collaterals.forEach((asset, i) => {
      const { price, cf, lcf } = db[instance].assets[asset];
      const amount = borrower.collaterals[asset];

      borrowLimit += amount * cf * price;
      liquidationLimit += amount * lcf * price;
    });

    db[instance].borrowers[account].borrowLimit = borrowLimit / basePrice;
    db[instance].borrowers[account].liquidationLimit = liquidationLimit / basePrice;
    db[instance].borrowers[account].percentToLiquidation = +((borrowValue / liquidationLimit) * 100).toFixed();

    if (collaterals.length === 1) {
      const [ asset, collateralAmount ] = Object.entries(borrower.collaterals)[0];
      const collateralPrice = db[instance].assets[asset].price;
      const lcf = db[instance].assets[asset].lcf;
      db[instance].borrowers[account].liquidationPrice = borrowValue / collateralAmount / lcf;
    }
  });
}

// Auto-sync all Comet instance data but only if local data are stale
setInterval(syncDbWithBlockchains, autoSyncInterval);

// Sync chain data to local DB on boot
(async function onStart() {
  await syncDbWithBlockchains();

  const app = express();
  app.use(express.json({ limit: 100 }));
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(function(req, res, next) {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET');
    next();
  });

  app.get('/borrowers/:cometInstanceId', async function (req, res, next) {
    try {
      const result = JSON.parse(JSON.stringify(db[req.params.cometInstanceId]));

      // Convert object to array
      const borrowers = [];
      Object.keys(result.borrowers).forEach((account) => {
        result.borrowers[account].account = account;
        borrowers.push(result.borrowers[account]);
      });
      result.borrowers = borrowers;

      // Sort by percent to liquidation, descending
      result.borrowers.sort((a, b) => {
        return a.percentToLiquidation > b.percentToLiquidation ? -1 : 1;
      });

      res.json(result);
    } catch(e) {
      res.sendStatus(400);
    }
  });

  app.use(function(req, res, next) {
    res.sendStatus(400);
  });

  app.listen(port, () => {
    console.log(`App listening at http://localhost:${port}`)
  });

})().catch((e) => {
  console.error('Error occurred during boot function:', e);
});
