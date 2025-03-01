require('dotenv').config();
const axios = require('axios');
const ethers = require('ethers');
const router = require('express').Router();
const isBase64 = require('is-base64');
const { Lock } = require("async-await-mutex-lock");
let lock = new Lock();
const mongoose = require('mongoose');
const ERC721CONTRACT = mongoose.model('ERC721CONTRACT');
const ERC1155CONTRACT = mongoose.model('ERC1155CONTRACT');
const ERC1155HOLDING = mongoose.model('ERC1155HOLDING');
const NFTITEM = mongoose.model('NFTITEM');
const Listing = mongoose.model('Listing');
const Like = mongoose.model('Like');

const service_auth = require('./middleware/auth.tracker');
const toLowerCase = require('../utils/utils');

const provider = new ethers.providers.JsonRpcProvider(
  process.env.NETWORK_RPC,
  parseInt(process.env.NETWORK_CHAINID)
);
const validatorAddress = process.env.VALIDATORADDRESS;
const auctionAddress = process.env.AUCTION_ADDRESS;
const SimplifiedERC721ABI = require('../constants/simplifiederc721abi');
const SimplifiedERC1155ABI = require('../constants/simplifiederc1155abi');
const Logger = require('../services/logger');

const bannedCollections = new Map();
const loadedContracts = new Map();

const loadContract = (contractAddress, tokenType) => {
  let sc = loadedContracts.get(contractAddress);
  if (sc) return sc;
  else {
    let abi = tokenType == 721 ? SimplifiedERC721ABI : SimplifiedERC1155ABI;
    sc = new ethers.Contract(contractAddress, abi, provider);
    loadedContracts.set(contractAddress, sc);
    return sc;
  }
};

const getTokenUri = async (contractAddress, tokenID) => {
  let sc = loadedContracts.get(contractAddress);
  if (sc) {
    let uri = await sc.uri(tokenID);
    return uri;
  } else {
    sc = new ethers.Contract(contractAddress, SimplifiedERC1155ABI, provider);
    loadedContracts.set(contractAddress, sc);
    let uri = await sc.uri(tokenID);
    return uri;
  }
};

const getSupply = async (contractAddress, tokenID, ownerAddress) => {
  let sc = loadedContracts.get(contractAddress);
  if (sc) {
    let balance = await sc.balanceOf(ownerAddress, tokenID);
    return balance;
  } else {
    sc = new ethers.Contract(contractAddress, SimplifiedERC1155ABI, provider);
    loadedContracts.set(contractAddress, sc);
    let balance = await sc.balanceOf(ownerAddress, tokenID);
    return balance;
  }
};

const is721CollectionBanned = async (contractAddress) => {
  let isBanned = bannedCollections.get(contractAddress);
  if (isBanned) return true;
  try {
    let contract_721 = await ERC721CONTRACT.findOne({
      address: contractAddress,
      isAppropriate: false
    });
    if (contract_721) {
      bannedCollections.set(contractAddress, true);
      return true;
    } else {
      bannedCollections.set(contractAddress, false);
      return false;
    }
  } catch (error) {
    Logger.error(error);
    return false;
  }
};

const is1155CollectionBanned = async (contractAddress) => {
  let isBanned = bannedCollections.get(contractAddress);
  if (isBanned) return true;
  try {
    let contract_1155 = await ERC1155CONTRACT.findOne({
      address: contractAddress,
      isAppropriate: false
    });
    if (contract_1155) {
      bannedCollections.set(contractAddress, true);
      return true;
    } else {
      bannedCollections.set(contractAddress, false);
      return false;
    }
  } catch (error) {
    Logger.error(error);
    return false;
  }
};

const removeLike = async (contractAddress, tokenID) => {
  try {
    await Like.remove({
      contractAddress: contractAddress,
      tokenID: tokenID
    });
  } catch (error) {
    Logger.error(error);
  }
};

const randomIPFS = () => {
  const IPFSUris = [
    'https://openzoo.mypinata.cloud/ipfs/',
    'https://openzoo2.mypinata.cloud/ipfs/',
    'https://openzoo3.mypinata.cloud/ipfs/',
    
  ];

  let random = Math.floor(Math.random() * IPFSUris.length);

  return `${IPFSUris[random]}`;
};

const handle1155SingleTransfer = async (
  from,
  to,
  contractAddress,
  tokenID,
  value
) => {
  Logger.info(`handle1155SingleTransfer ${from} ${to} ${contractAddress} ${tokenID} ${value}`)
  try {
    let tk = await NFTITEM.findOne({
      contractAddress: contractAddress,
      tokenID: tokenID
    });

    Logger.info(`handle1155SingleTransfer tk ${tk}`)

    let fromSupply = await getSupply(contractAddress, tokenID, from);

    Logger.info(`handle1155SingleTransfer fromSupply ${fromSupply}`)

    let db_fromSupply = await ERC1155HOLDING.findOne({
      contractAddress: contractAddress,
      tokenID: tokenID,
      holderAddress: from
    });

    Logger.info(`handle1155SingleTransfer db_fromSupply ${db_fromSupply}`)

    if (!db_fromSupply && db_fromSupply !== null) {
      db_fromSupply = parseInt(db_fromSupply.supplyPerHolder);
    }
    if (db_fromSupply == fromSupply) {

    }

    Logger.info(`handle1155SingleTransfer validatorAddress ${validatorAddress}`)

    if (to == validatorAddress) {
      // burn -- only when token already exists
      if (tk) {
        let supply = tk.supply;
        if (supply == value) {
          // this is the final burn
          try {
            await tk.remove();
            await ERC1155HOLDING.deleteMany({
              contractAddress: contractAddress,
              tokenID: tokenID
            });
            await removeLike(contractAddress, tokenID);
          } catch (error) {
            Logger.error(error);
          }
        } else {
          // now remove the supply
          supply = supply - value;
          tk.supply = supply;
          await tk.save();
          let holding = await ERC1155HOLDING.findOne({
            contractAddress: contractAddress,
            tokenID: tokenID,
            holderAddress: from
          });

          Logger.info(`handle1155SingleTransfer holding ${holding}`)

          holding = parseInt(holding.supplyPerHolder) - value;
          await holding.save();
        }
      } else {
        return res.json({});
      }
    } else if (from == validatorAddress) {
      // mint
      let toSupply = await getSupply(contractAddress, tokenID, to);
      let db_toSupply = await ERC1155HOLDING.findOne({
        contractAddress: contractAddress,
        tokenID: tokenID,
        holderAddress: to
      });
      Logger.info(`handle1155SingleTransfer db_toSupply ${db_toSupply}`)

      if (db_toSupply) {
        if (db_toSupply.supplyPerHolder != toSupply) {
          db_toSupply.supplyPerHolder = toSupply;
          await db_toSupply.save();
        }
      } else {
        // this is a new mint
        let tk = await NFTITEM.findOne({
          contractAddress: contractAddress,
          tokenID: tokenID
        });
        if (!tk) {
          try {

            let imageURL = '';
            let tokenURI = await getTokenUri(contractAddress, tokenID);
            // now check if token uri is base64
            if (tokenURI.startsWith('data:application/json;base64,')) {
              tokenURI = tokenURI.split(',');
              tokenURI = tokenURI[1];
              let isBased64Encoded = isBase64(tokenURI);
              if (isBased64Encoded) {
                try {
                  metadata = Buffer.from(tokenURI, 'base64').toString('utf8');
                  metadata = JSON.parse(metadata);
                  tokenName = metadata.name;
                  imageURL = metadata.image;
                } catch (error) {
                  Logger.error(error);
                }
              }
            } else {
              let metadataURI = tokenURI;
              if (tokenURI.includes('ipfs://')) {
                let uri = tokenURI.split('ipfs://')[1].replace(/([^:]\/)\/+/g, "$1");
                metadataURI = `https://openzoo.mypinata.cloud/ipfs/${uri}`;
              }
              metadata = await axios.get(metadataURI);
              try {
                tokenName = metadata.data.name;
                imageURL = metadata.data.image;

                // Get content Type //
                if (metadata.data.animation_url) {
                  let ext = metadata.data.animation_url ? metadata.data.animation_url.split('.').pop() : '';
                  switch (ext) {
                    case 'mp4': contentType = "video"; break;
                    case 'mp3': contentType = "sound"; break;
                    case 'glb': contentType = "model"; break;
                  }
                }
                else
                {
                  contentType = "image";
                }

              } catch (error) {
                Logger.error(error);
              }
            }


            let newTk = new NFTITEM();
            newTk.name = tokenName;
            newTk.contractAddress = contractAddress;
            newTk.tokenID = tokenID;
            newTk.supply = value;
            newTk.createdAt = new Date();
            newTk.imageURL = imageURL;
            newTk.tokenURI = tokenURI ? tokenURI : 'https://';
            newTk.tokenType = 1155;
            let isBanned = await is1155CollectionBanned(contractAddress);
            newTk.isAppropriate = !isBanned;
            newTk.contentType = contentType;
            await newTk.save();
          } catch (error) {
            Logger.error(error);
          }
        }
        let holding = await ERC1155HOLDING.findOne({
          contractAddress: contractAddress,
          tokenID: tokenID,
          holderAddress: to
        });
        if (!holding) {
          try {
            // now update the holdings collection
            let holding = new ERC1155HOLDING();
            holding.contractAddress = contractAddress;
            holding.tokenID = tokenID;
            holding.holderAddress = to;
            holding.supplyPerHolder = value;
            await holding.save();
          } catch (error) {
            Logger.error(error);
          }
        }
      }
    } else {
      // transfer
      let fromSupply = await getSupply(contractAddress, tokenID, from);
      let toSupply = await getSupply(contractAddress, tokenID, to);
      let db_fromSupply = await ERC1155HOLDING.findOne({
        contractAddress: contractAddress,
        tokenID: tokenID,
        holderAddress: from
      });
      let db_toSupply = await ERC1155HOLDING.findOne({
        contractAddress: contractAddress,
        tokenID: tokenID,
        holderAddress: to
      });
      if (db_fromSupply) {
        try {
          if (parseInt(db_fromSupply.supplyPerHolder) != fromSupply) {
            db_fromSupply.supplyPerHolder = fromSupply;
            await db_fromSupply.save();
          }
        } catch (error) {
          Logger.error(error);
        }
      }
      if (db_toSupply) {
        try {
          if (parseInt(db_toSupply.supplyPerHolder) != toSupply) {
            db_toSupply.supplyPerHolder = toSupply;
            await db_toSupply.save();
          }
        } catch (error) {
          Logger.error(error);
        }
      } else {
        try {
          // now update the holdings collection
          let holding = new ERC1155HOLDING();
          holding.contractAddress = contractAddress;
          holding.tokenID = tokenID;
          holding.holderAddress = to;
          holding.supplyPerHolder = toSupply;
          await holding.save();
          Logger.info(`handle1155SingleTransfer save finish`)

        } catch (error) {
          Logger.error('handle1155SingleTransfer 2');

          Logger.error(error);
        }
      }
    }
  } catch (error) {
    Logger.error('handle1155SingleTransfer');
    Logger.error(error);
  }
};

router.post(
  '/handle721Transfer',
    service_auth, async (req, res) => {
    await lock.acquire();
    try {
      let address = toLowerCase(req.body.address); //contract address
      let to = toLowerCase(req.body.to); // transferred to
      let tokenID = parseInt(req.body.tokenID); //tokenID
      console.log('Transffered to: ', to);
      if (address === undefined || to === undefined || tokenID === undefined) {
        throw new Error('Some parameters are missing');
      }
      // remove existing listing(s)
      await Listing.deleteMany({
        minter: address,
        tokenID: tokenID
      });

      let erc721token = await NFTITEM.findOne({
        contractAddress: address,
        tokenID: tokenID
      });

      
      if (erc721token) {
        console.log('[Existed] Transferred to ',to);
        if (to == toLowerCase(auctionAddress)) // Don't change owner
        {
          return res.json({});
        }
        if (to == erc721token.owner) {
          return res.json({});
        }
        // Burn Item //
        if (to == '0x000000000000000000000000000000000000000f')
        {
          console.log('[Burned!] '+address+'|'+tokenID);
          await erc721token.remove();
          await removeLike(address, tokenID);
          return res.json(); 
        }
        if (to == validatorAddress) {
          await erc721token.remove();
          await removeLike(address, tokenID);
          return res.json();
        } else {
          erc721token.owner = to;
          let now = Date.now();
          try {
            if (erc721token.createdAt > now) erc721token.createdAt = now;
          } catch (error) {
            Logger.error(error);
          }
          await erc721token.save();
          return res.json({});
        }
      } else {
        if (to == '0x000000000000000000000000000000000000000f')
        {
          return res.json({});
        }
        console.log('[NewNFT] Transferred to ',to);
        let sc = loadContract(address, 721);
        let tokenURI = await sc.tokenURI(tokenID);
        let metadata;
        let tokenName = '';
        let imageURL = '';
        let contentType = 'image';
        // now check if token uri is base64
        if (tokenURI.startsWith('data:application/json;base64,')) {
          tokenURI = tokenURI.split(',');
          tokenURI = tokenURI[1];
          let isBased64Encoded = isBase64(tokenURI);
          if (isBased64Encoded) {
            try {
              metadata = Buffer.from(tokenURI, 'base64').toString('utf8');
              metadata = JSON.parse(metadata);
              tokenName = metadata.name;
              imageURL = metadata.image;
            } catch (error) {
              Logger.error(error);
            }
          }
        } else {
          let metadataURI = tokenURI;
          if (tokenURI.includes('ipfs://')) {
            let uri = tokenURI.split('ipfs://')[1].replace(/([^:]\/)\/+/g, "$1");
            metadataURI = `${randomIPFS()}${uri}`;
          }

          if (
            tokenURI.includes('pinata.cloud') ||
            tokenURI.includes('cloudflare') ||
            tokenURI.includes('ipfs.io') ||
            tokenURI.includes('ipfs.infura.io')
          ) {
            let uri = tokenURI.split('/ipfs/')[1];
            metadataURI = `${randomIPFS()}${uri}`;
          }

          metadata = await axios.get(metadataURI);
          try {
            tokenName = metadata.data.name;
            imageURL = metadata.data.image;

            // Get content Type //
            if (metadata.data.animation_url) {
              let ext = metadata.data.animation_url ? metadata.data.animation_url.split('.').pop() : '';
              switch (ext) {
                case 'mp4': contentType = "video"; break;
                case 'mp3': contentType = "sound"; break;
                case 'glb': contentType = "model"; break;
              }
            }

          } catch (error) {
            Logger.error(error);
          }
        }



        if (to == validatorAddress) {
          return res.json();
        } else { // Save a new NFT //
          let newTk = new NFTITEM();
          newTk.contractAddress = address;
          newTk.tokenID = tokenID;
          newTk.name = tokenName;
          newTk.tokenURI = tokenURI;
          newTk.imageURL = imageURL;
          newTk.owner = to;
          newTk.createdAt = Date.now();
          let isBanned = await is721CollectionBanned(address);
          newTk.isAppropriate = !isBanned;
          newTk.contentType = contentType;
          await newTk.save();
          return res.json();
        }
      }
    } catch (error) {
      Logger.error(error);
      return res.json({});
    } finally {
      lock.release();
      console.log('Released Lock');
    }
  }
);

router.post('/handle1155SingleTransfer', service_auth, async (req, res) => {
  try {
    let address = toLowerCase(req.body.address);
    let from = toLowerCase(req.body.from);
    let to = toLowerCase(req.body.to);
    let id = parseInt(req.body.id);
    let value = parseInt(req.body.value);
    await handle1155SingleTransfer(from, to, address, id, value);
    return res.json();
  } catch (error) {
    Logger.error(error);
    return res.json({});
  }
});

router.post('/handle1155URI', service_auth, async (req, res) => {
  try {
    let address = toLowerCase(req.body.address);
    let id = parseInt(req.body.id);
    let value = req.body.value;
    let tk = await NFTITEM.findOne({
      contractAddress: address,
      tokenID: id
    });
    if (!tk) {
    } else {
      let _tkURI = tk.tokenURI;
      if (_tkURI == 'https://') {
        tk.tokenURI = value;
      }
      try {
        let metadata = await axios.get(_tkURI);
        let name = metadata.data.name;
        let imageURL = metadata.data.image;
        tk.imageURL = imageURL;
        tk.name = name;
        tk.thumbnailPath = '-';
      } catch (error) {
        tk.name = '';
      }
      await tk.save();
      return res.json();
    }
  } catch (error) {
    Logger.error(error);
    return res.json();
  }
});

router.post('/handle1155BatchTransfer', service_auth, async (req, res) => {
  try {
    let address = toLowerCase(req.body.address);
    let from = toLowerCase(req.body.from);
    let to = toLowerCase(req.body.to);
    let ids = req.body.id;
    ids = ids.split(',');
    let values = req.body.value;
    values = values.split(',');
    let promises = ids.map(async (_, index) => {
      operator = toLowerCase(operator);
      from = toLowerCase(from);
      to = toLowerCase(to);
      let id = ids[index];
      id = parseFloat(id.toString());
      let value = values[index];
      value = parseFloat(value.toString());
      await handleTransferSingle(from, to, address, id, value);
    });
    await Promise.all(promises);
    return res.json({});
  } catch (error) {
    Logger.error(error);
    return res.json();
  }
});

router.get('/getTrackable721Contracts', service_auth, async (req, res) => {
  try {
    console.log('getTrackable721Contracts 0');
    let contracts = await ERC721CONTRACT.find({ isAppropriate: true });
    console.log('getTrackable721Contracts 1');

    let trackable_scs = [];
    contracts.map((contract) => {
      trackable_scs.push(contract.address);
    });

    console.log('getTrackable721Contracts 2');

    return res.json({
      status: 'success',
      data: trackable_scs
    });
  } catch (error) {
    console.log('getTrackable721Contracts 3', error);

    Logger.error(error);
    return res.json({
      status: 'failed',
      data: []
    });
  }
});
router.get('/getTrackable1155Contracts', service_auth, async (req, res) => {
  try {
    let contracts = await ERC1155CONTRACT.find({ isAppropriate: true });
    let trackable_scs = [];
    contracts.map((contract) => {
      trackable_scs.push(contract.address);
    });
    return res.json({
      status: 'success',
      data: trackable_scs
    });
  } catch (error) {
    Logger.error(error);
    console.log(error);
    return res.json({
      status: 'failed',
      data: []
    });
  }
});

module.exports = router;
