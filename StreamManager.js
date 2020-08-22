import {SignallingServerConnection} from './Signalling.js';

import EventProvider from './EventProvider.js';

import Peer from 'simple-peer';

const StreamState = {
  kNotTracking: 'not tracking',
  kResetting: 'resetting',
  kInitializing: 'initializing',
  kStreaming: 'streaming',
  kBroken: 'broken',
};

// emits a "streamUpdate" when a stream changes
// { id: id, stream: stream }
// TODO better documentation

class StreamManager extends EventProvider {
  constructor(auth, wrtc) {
    super([
      'streamIn',
      'streamOut',
      'streamUpdate',
      'mutedVideo',
      'mutedAudio',
    ]);
    this.auth = auth;
    this.wrtc = wrtc;
    this.myId = '';
    this.userMediaConfig = {};
    this.initialized = false;
    this.ready = false;
    this.pendingActions = [];

    this.streamOut = null;
    this.signalServer = null;

    this.pendingSignals = {};
    // this is like a defaultdict with default value StreamState.kNotTracking
    this.states = new Proxy(
      {},
      {
        get: (target, name) =>
          name in target ? target[name] : StreamState.kNotTracking,
      },
    );
    this.peers = {};
    this.streamsIn = {};
    this.streamsOut = {};
    this.initializingTimers = {};
    this.brokenTimers = {};

    this.audioEnabled = {};
    this.videoEnabled = {};
    this.globalVideoEnabled = true;
    this.globalAudioEnabled = true;
  }

  destroy() {
    if (this.signalServer) {
      this.signalServer.destroy();
    }
    this.removeAll();
    if (this.streamOut) {
      this.streamOut.getTracks().forEach(track => {
        track.stop();
      });
      this.streamOut = null;
    }
    this.initialized = false;
  }

  initialize(uuid, userMediaConfig) {
    if (this.initialized) {
      console.log('StreamManager: already initialized');
      this.fire('streamOut', streamOut);
      return;
    }
    if (!this.wrtc.mediaDevices) {
      console.log('StreamManager: navigator.mediaDevices not available');
      return;
      // TODO can't stream: show error
    }
    this.myId = this.auth.currentUser.uid;
    this.userMediaConfig = userMediaConfig;
    this.initialized = true;

    this.signalServer = new SignallingServerConnection(uuid, this.auth);
    this.signalServer.on('message', msg => {
      if (msg.event === 'signal') {
        let from = msg.from;
        let data = msg.data;
        if ([StreamState.kInitializing].includes(this.states[from])) {
          this._clearTimeouts(from);
          this.initializingTimers[from] = setTimeout(
            this._initializing.bind(this, from),
            StreamManager.kInitializingTimeout,
          );
          try {
            console.log('<- peer signal', from);
            this.peers[from].signal(data);
          } catch (err) {
            console.log('StreamManager: dropping signal (is peer destroyed?)');
          }
        } else if (
          [StreamState.kResetting, StreamState.kNotTracking].includes(
            this.states[from],
          )
        ) {
          this.pendingSignals[from] = data;
        } else if (
          [StreamState.kStreaming, StreamState.kBroken].includes(
            this.states[from],
          )
        ) {
          this.pendingSignals[from] = data;
          this._initializing(from);
        }
      } else if (msg.event === 'request_offer') {
        let from = msg.from;
        console.log('<- peer request offer', from);
        if (
          [StreamState.kStreaming, StreamState.kBroken].includes(
            this.states[from],
          )
        ) {
          this._initializing(from);
        }
      }
    });

    return this.initializeStreamOut();
  }

  initializeStreamOut() {
    return this.wrtc.mediaDevices
      .getUserMedia(this.userMediaConfig)
      .then(streamOut => {
        console.log('<- localStream initialized');
        this.streamOut = streamOut;
        this.streamsOut[this.myId] = streamOut;
        this.streamOut.getTracks().forEach(track => {
          track.addEventListener('ended', () => {
            // get the stream back
            this.initializeStreamOut(); // TODO this might be bad
            console.log('<- localStream ended');
          });
        });
        this.fire('streamOut', streamOut);
        this.ready = true;
        this.pendingActions.forEach(action => {
          let func, args;
          [func, ...args] = action;
          func(...args);
        });
        this.pendingActions = [];
      })
      .catch(err => {
        console.log(err);
        this.initializeStreamOut();
      });
  }

  addVideo(id) {
    //  console.log("<- addVideo", id);
    // TODO maybe cache the peer connection and just deal with videotracks
    // enabled or not
    if (!this.ready) {
      // don't initialize until StreamManager is ready
      this.pendingActions.push([this.addVideo.bind(this), id]);
      return;
    }
    if (this.states[id] !== StreamState.kNotTracking) {
      return;
    }
    this.audioEnabled[id] = true;
    this.videoEnabled[id] = true;
    this._initializing(id);
  }

  removeVideo(id) {
    //  console.log("<- removeVideo", id);
    if (!this.ready) {
      // don't initialize until StreamManager is ready
      this.pendingActions.push([this.removeVideo.bind(this), id]);
      return;
    }
    if (this.states[id] === StreamState.kNotTracking) {
      return;
    }
    this.audioEnabled[id] = false;
    this.videoEnabled[id] = false;
    this._notTracking(id);
  }

  removeAll() {
    Object.keys(this.states).forEach(id => {
      this.removeVideo(id);
    });
  }

  setMuteVideo(id, muted) {
    this.videoEnabled[id] = !muted;
    if (id in this.streamsOut) {
      this.streamsOut[id].getVideoTracks().forEach(track => {
        track.enabled = !muted && this.globalVideoEnabled;
      });
    }
  }

  setMuteVideoAll(muted) {
    this.globalVideoEnabled = !muted;
    Object.keys(this.streamsOut).forEach(id => {
      this.setMuteVideo(id, muted);
    });
    this.fire('mutedVideo', muted);
  }

  setMuteAudio(id, muted) {
    this.audioEnabled[id] = !muted;
    if (id in this.streamsOut) {
      this.streamsOut[id].getAudioTracks().forEach(track => {
        track.enabled = !muted && this.globalAudioEnabled;
      });
    }
  }

  setMuteAudioAll(muted) {
    this.globalAudioEnabled = !muted;
    Object.keys(this.streamsOut).forEach(id => {
      this.setMuteAudio(id, muted);
    });
    this.fire('mutedAudio', muted);
  }

  assertControl() {
    if (!this.ready) {
      this.pendingActions.push([this.assertControl.bind(this)]);
      return;
    }
    this.signalServer.assertControl();
  }

  _initializing(id) {
    if (!this.streamOut) {
      console.log('StreamManager: error initializing: streamOut missing');
      return;
      // TODO assertion failure
    }
    // TODO do you need to reset if you're not the initiator?
    this._reset(id);
    this.initializingTimers[id] = setTimeout(
      this._initializing.bind(this, id),
      StreamManager.kInitializingTimeout,
    );
    let isInitiator = this.myId < id;
    if (!isInitiator) {
      console.log('-> peer request offer', id);
      this.signalServer.requestOffer(id);
    }
    if (navigator.mediaDevices !== undefined) {
      // we have a browser
      this.streamsOut[id] = this.streamOut.clone();
    } else {
      // TODO fix this for mobile! it sucks!
      this.streamsOut[id] = this.streamOut;
    }
    this.peers[id] = new Peer({
      wrtc: this.wrtc,
      initiator: isInitiator,
      trickle: false, // TODO can I make this true?
      config: {
        iceServers: [
          {urls: 'BLANK'},
          {urls: 'BLANK'},
          {
            urls: 'BLANK',
            username: 'user',
            credential: 'password',
          },
          // TODO Twilio TURN?
        ],
      },
      stream: this.streamsOut[id],
    });
    if (id in this.pendingSignals) {
      console.log('<- peer signal', id);
      this.peers[id].signal(this.pendingSignals[id]);
      delete this.pendingSignals[id];
    }
    console.log('= initializing', id);
    this.states[id] = StreamState.kInitializing;
    this.fire('streamUpdate', {id: id, state: this.states[id]});
    this.peers[id].on('connect', () => {
      console.log('<- peer connect', id);
    });
    this.peers[id].on('stream', streamIn => {
      console.log('<- peer stream', id, streamIn);
      this._streaming(id, streamIn);
    });
    this.peers[id].on('signal', data => {
      console.log('-> peer signal', id);
      this.signalServer.signal(id, data);
    });
    this.peers[id].on('close', () => {
      console.log('<- peer close', id);
      // need to go to Resetting state because the peer is gone now
      this._initializing(id);
    });
    this.peers[id].on('error', err => {
      console.log('<- peer error', id, err);
      // TODO do something?
    });
  }

  _notTracking(id) {
    this._reset(id);
    console.log('= not tracking', id);
    this.states[id] = StreamState.kNotTracking;
    this.fire('streamUpdate', {id: id, state: this.states[id]});
  }

  _streaming(id, streamIn) {
    console.log('= streaming', id);
    this.states[id] = StreamState.kStreaming;
    this.fire('streamUpdate', {id: id, state: this.states[id]});
    this._clearTimeouts(id);
    this.streamsIn[id] = streamIn;
    let streamOut = this.streamsOut[id];
    streamOut.getVideoTracks().forEach(track => {
      track.enabled = this.videoEnabled[id] && this.globalVideoEnabled;
    });
    streamOut.getAudioTracks().forEach(track => {
      track.enabled = this.audioEnabled[id] && this.globalAudioEnabled;
    });
    streamIn.getVideoTracks().forEach(track => {
      track.addEventListener('mute', () => {
        console.log('<- track mute', track);
        if (this.states[id] === StreamState.kStreaming) {
          this._broken(id, streamIn);
        }
      });
      track.addEventListener('ended', () => {
        console.log('<- track ended', track);
        // TODO do something?
      });
      track.addEventListener('unmute', () => {
        console.log('<- track unmute', track);
        clearTimeout(this.brokenTimers[id]);
        if (this.states[id] === StreamState.kBroken) {
          console.log('= streaming', id);
          this.states[id] = StreamState.kStreaming;
          this.fire('streamUpdate', {id: id, state: this.states[id]});
        }
      });
    });
    this.fire('streamIn', {id: id, stream: streamIn});
  }

  _broken(id, streamIn) {
    console.log('= stream broken', id);
    this.states[id] = StreamState.kBroken;
    this.fire('streamUpdate', {id: id, state: this.states[id]});
    this._clearTimeouts(id);
    this.brokenTimers[id] = setTimeout(
      this._initializing.bind(this, id),
      StreamManager.kBrokenTimeout,
    );
  }

  _reset(id) {
    console.log('= resetting', id);
    this.states[id] = StreamState.kResetting;
    this.fire('streamUpdate', {id: id, state: this.states[id]});
    this._clearTimeouts(id);
    if (id in this.peers) {
      this.peers[id].removeAllListeners();
      this.peers[id].destroy();
      delete this.peers[id];
    }
    if (id in this.streamsIn) {
      this.streamsIn[id].getTracks().forEach(track => {
        track.stop();
      });
      delete this.streamsIn[id];
    }
    if (
      navigator.mediaDevices && // only delete streamOut if we're a browser
      id in this.streamsOut
    ) {
      this.streamsOut[id].getTracks().forEach(track => {
        track.stop();
      });
      delete this.streamsOut[id];
    }
  }

  _clearTimeouts(id) {
    clearTimeout(this.brokenTimers[id]);
    clearTimeout(this.initializingTimers[id]);
  }
}

StreamManager.kInitializingTimeout = 30000;
StreamManager.kBrokenTimeout = 30000;

export {StreamManager as default, StreamState};
