const NoiseState = require('noise-handshake')
const curve = require('noise-curve-ed')
const c = require('compact-encoding')
const sodium = require('sodium-universal')
const Holepuncher = require('./holepuncher')
const messages = require('./messages')
const AddressSet = require('./address-set')

const NOISE_PROLOUGE = Buffer.alloc(0)

const PROBE = 0
const PUNCH = 1
const ABORT = 2

class ServerConnector {
  constructor (dht, keyPair, announcer) {
    this.dht = dht
    this.keyPair = keyPair
    this.announcer = announcer
    this.connects = new Map()
    this.holepunches = []
  }

  _addHandshake (k, noise) {
    const handshake = new NoiseState('IK', false, this.keyPair, { curve })

    handshake.initialise(NOISE_PROLOUGE)

    let remotePayload = null
    try {
      remotePayload = c.decode(messages.noisePayload, handshake.recv(noise))
    } catch {
      return null
    }

    // TODO: run firewall function also obvs

    let id = this.holepunches.indexOf(null)
    if (id === -1) id = this.holepunches.push(null) - 1

    const payload = c.encode(messages.noisePayload, { id })
    const reply = handshake.send(payload)
    const punch = new Holepuncher(this.dht, handshake.digest)

    punch.nat.autoSample()

    const hs = {
      id,
      punch,
      reply,
      destroy: null,
      timeout: null
    }

    hs.destroy = () => {
      if (id >= this.holepunches.length || this.holepunches[id] !== hs) return

      this.holepunches[id] = null
      while (this.holepunches.length > 0 && this.holepunches[this.holepunches.length - 1] === null) {
        this.holepunches.pop()
      }
      this.connects.delete(k)
      punch.destroy()
    }

    hs.timeout = setTimeout(hs.destroy, 30000)

    this.holepunches[id] = hs
    this.connects.set(k, noise)

    return hs
  }

  async onconnect (noise) {
    const k = noise.toString('hex')
    let h = this.connects.get(k)

    if (!h) {
      h = this._addHandshake(k, noise)
      if (!h) return null
    }

    return { socket: h.punch.socket, noise: h.reply }
  }

  async onholepunch ({ id, peerAddress, payload }, req) {
    const h = id < this.holepunches.length ? this.holepunches[id] : null
    if (!h) return null

    const p = h.punch
    const remotePayload = p.decryptPayload(payload)
    if (!remotePayload) return null

    const isServerRelay = this.announcer.has(req.from.host, req.from.port)
    const { status, nat, address, remoteAddress, remoteToken } = remotePayload

    if (status === ABORT) return abort(h)

    const token = p.token(peerAddress)
    const echoed = isServerRelay && !!remoteToken && token.equals(remoteToken)

    // Update our heuristics here
    if (req.socket === p.socket) {
      p.nat.add(req.to, req.from)
    }
    if (p.remoteNat === 0 && nat !== 0 && address) {
      p.remoteNat = nat
      p.remoteAddress = address
    }
    if (echoed && p.remoteAddress && p.remoteAddress.host === peerAddress.host) {
      p.remoteVerified = true
    }
    if (status === PUNCH) {
      p.remoteHolepunching = true
    }

    // Wait for the analyzer to reach a conclusion...
    // We might want to make this more fancy and use a SignalPromise to have it wait max for a timeout etc
    await nat.analyzing

    // Fast mode! If we are consistent and the remote has opened a session to us (remoteAddress)
    // then fire a quick punch back. Note the await here just waits for the udp socket to flush.
    if (p.nat.type === 1 && remoteAddress && sameAddr(p.nat.address, remoteAddress)) {
      await p.ping(peerAddress)
    }

    console.log('server round...', {
      isServerRelay,
      remoteNat: p.remoteNat,
      remoteHolepunching: p.remoteHolepunching,
      remoteAddress: p.remoteAddress,
      remoteVerified: p.remoteVerified
    })

    return {
      socket: p.socket,
      payload: p.encryptPayload({
        status: remotePayload.status,
        nat: p.nat.type,
        address: p.nat.address,
        remoteAddress: null,
        token: (isServerRelay && !p.remoteVerified) ? token : null,
        remoteToken: remotePayload.token
      })
    }
  }
}

module.exports = class Server {
  constructor (dht) {
    this.dht = dht
    this.keyPair = null
    this.relayNodes = new AddressSet()
  }

  async announce () {
    const relayNodes = this.relayNodes
    const publicKey = this.keyPair.publicKey
    const target = hash(publicKey)

    relayNodes.gc()

    const q = this.dht.query({ command: 'lookup', target }, {
      async commit (msg, dht) {
        const res = await this.dht.request({
          token: msg.token,
          command: 'announce',
          target,
          value: publicKey
        }, msg.from)

        if (res.error === 0) {
          relayNodes.add(msg.from.host, msg.from.port)
        }

        return res
      }
    })

    await q.finished()

    // TODO: just a quick fix...
    setTimeout(() => this.announce(), 60000)
  }

  listen (keyPair) {
    this.keyPair = keyPair
    this.dht._router.set(hash(keyPair.publicKey), {
      relay: null,
      server: new ServerConnector(this.dht, keyPair, this.relayNodes)
    })

    return this.announce()
  }
}

function hash (data) {
  const out = Buffer.allocUnsafe(32)
  sodium.crypto_generichash(out, data)
  return out
}

function sameAddr (a, b) {
  return a.host === b.host && a.port === b.port
}

function abort (h) {
  const payload = h.punch.encryptPayload({
    status: ABORT,
    nat: 0,
    address: null,
    remoteAddress: null,
    token: null,
    remoteToken: null
  })

  h.destroy()

  return { socket: null, payload }
}