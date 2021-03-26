'use strict'

const { UnixFS } = require('ipfs-unixfs')
const persist = require('../../utils/persist')
const {
  encode,
  prepare
// @ts-ignore
} = require('@ipld/dag-pb')
const mc = require('multicodec')

/**
 * @typedef {import('../../types').BufferImporter} BufferImporter
 */

/**
 * @type {BufferImporter}
 */
async function * bufferImporter (file, block, options) {
  for await (let buffer of file.content) {
    yield async () => {
      options.progress(buffer.length, file.path)
      let unixfs

      /** @type {import('../../types').PersistOptions} */
      const opts = {
        codec: mc.DAG_PB,
        cidVersion: options.cidVersion,
        hasher: options.hasher,
        onlyHash: options.onlyHash
      }

      if (options.rawLeaves) {
        opts.codec = mc.RAW
        opts.cidVersion = 1
      } else {
        unixfs = new UnixFS({
          type: options.leafType,
          data: buffer,
          mtime: file.mtime,
          mode: file.mode
        })

        buffer = encode(prepare({ Data: unixfs.marshal() }))
      }

      return {
        cid: await persist(buffer, block, opts),
        unixfs,
        size: buffer.length
      }
    }
  }
}

module.exports = bufferImporter
