'use strict'

const errCode = require('err-code')
const { UnixFS } = require('ipfs-unixfs')
const persist = require('../../utils/persist')
const { encode, prepare } = require('@ipld/dag-pb')
const parallelBatch = require('it-parallel-batch')
const mc = require('multicodec')
const rawCodec = require('multiformats/codecs/raw')

/**
 * @typedef {import('../../types').BlockAPI} BlockAPI
 * @typedef {import('../../types').File} File
 * @typedef {import('../../types').ImporterOptions} ImporterOptions
 * @typedef {import('../../types').Reducer} Reducer
 * @typedef {import('../../types').DAGBuilder} DAGBuilder
 * @typedef {import('../../types').FileDAGBuilder} FileDAGBuilder
 */

/**
 * @type {{ [key: string]: FileDAGBuilder}}
 */
const dagBuilders = {
  flat: require('./flat'),
  balanced: require('./balanced'),
  trickle: require('./trickle')
}

/**
 * @param {File} file
 * @param {BlockAPI} block
 * @param {ImporterOptions} options
 */
async function * buildFileBatch (file, block, options) {
  let count = -1
  let previous
  let bufferImporter

  if (typeof options.bufferImporter === 'function') {
    bufferImporter = options.bufferImporter
  } else {
    bufferImporter = require('./buffer-importer')
  }

  for await (const entry of parallelBatch(bufferImporter(file, block, options), options.blockWriteConcurrency)) {
    count++

    if (count === 0) {
      previous = entry
      continue
    } else if (count === 1 && previous) {
      yield previous
      previous = null
    }

    yield entry
  }

  if (previous) {
    previous.single = true
    yield previous
  }
}

/**
 * @param {File} file
 * @param {BlockAPI} block
 * @param {ImporterOptions} options
 */
const reduce = (file, block, options) => {
  /**
   * @type {Reducer}
   */
  async function reducer (leaves) {
    if (leaves.length === 1 && leaves[0].single && options.reduceSingleLeafToSelf) {
      const leaf = leaves[0]

      if (leaf.cid.code === rawCodec.code && (file.mtime !== undefined || file.mode !== undefined)) {
        // only one leaf node which is a buffer - we have metadata so convert it into a
        // UnixFS entry otherwise we'll have nowhere to store the metadata
        let { bytes: buffer } = await block.get(leaf.cid, options)

        leaf.unixfs = new UnixFS({
          type: 'file',
          mtime: file.mtime,
          mode: file.mode,
          data: buffer
        })

        buffer = encode(prepare({ Data: leaf.unixfs.marshal() }))

        // // TODO vmx 2021-03-26: This is what the original code does, it checks
        // // the multihash of the original leaf node and uses then the same
        // // hasher. i wonder if that's really needed or if we could just use
        // // the hasher from `options.hasher` instead.
        // const multihash = mh.decode(leaf.cid.multihash.bytes)
        // let hasher
        // switch multihash {
        //   case sha256.code {
        //     hasher = sha256
        //     break;
        //   }
        //   //case identity.code {
        //   //  hasher = identity
        //   //  break;
        //   //}
        //   default: {
        //     throw new Error(`Unsupported hasher "${multihash}"`)
        //   }
        // }
        leaf.cid = await persist(buffer, block, {
          ...options,
          codec: mc.DAG_PB,
          hasher: options.hasher,
          cidVersion: options.cidVersion
        })
        leaf.size = buffer.length
      }

      return {
        cid: leaf.cid,
        path: file.path,
        unixfs: leaf.unixfs,
        size: leaf.size
      }
    }

    // create a parent node and add all the leaves
    const f = new UnixFS({
      type: 'file',
      mtime: file.mtime,
      mode: file.mode
    })

    const links = leaves
      .filter(leaf => {
        if (leaf.cid.code === rawCodec.code && leaf.size) {
          return true
        }

        if (leaf.unixfs && !leaf.unixfs.data && leaf.unixfs.fileSize()) {
          return true
        }

        return Boolean(leaf.unixfs && leaf.unixfs.data && leaf.unixfs.data.length)
      })
      .map((leaf) => {
        if (leaf.cid.code === rawCodec.code) {
          // node is a leaf buffer
          f.addBlockSize(leaf.size)

          return {
            Name: '',
            Tsize: leaf.size,
            Hash: leaf.cid
          }
        }

        if (!leaf.unixfs || !leaf.unixfs.data) {
          // node is an intermediate node
          f.addBlockSize((leaf.unixfs && leaf.unixfs.fileSize()) || 0)
        } else {
          // node is a unixfs 'file' leaf node
          f.addBlockSize(leaf.unixfs.data.length)
        }

        return {
          Name: '',
          Tsize: leaf.size,
          Hash: leaf.cid
        }
      })

    const node = {
      Data: f.marshal(),
      Links: links
    }
    const buffer = encode(prepare(node))
    const cid = await persist(buffer, block, options)

    return {
      cid,
      path: file.path,
      unixfs: f,
      size: buffer.length + node.Links.reduce((acc, curr) => acc + curr.Tsize, 0)
    }
  }

  return reducer
}

/**
 * @type {import('../../types').UnixFSV1DagBuilder<File>}
 */
function fileBuilder (file, block, options) {
  const dagBuilder = dagBuilders[options.strategy]

  if (!dagBuilder) {
    throw errCode(new Error(`Unknown importer build strategy name: ${options.strategy}`), 'ERR_BAD_STRATEGY')
  }

  return dagBuilder(buildFileBatch(file, block, options), reduce(file, block, options), options)
}

module.exports = fileBuilder
