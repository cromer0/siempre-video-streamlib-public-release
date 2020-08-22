import EventProvider from './EventProvider';

// emits a "message" every time we get a message
// { from: from, data: data }
// TODO better documentation
class SignallingServerConnection extends EventProvider {
  constructor(uuid, auth) {
    super(['message']);
    this.uuid = uuid;
    this.auth = auth;
    this.pendingSignals = [];
    this.isConnected = false;
    this.openListener = () => {};
    this.messageListener = () => {};
    this.closeListener = () => {};
    this.errorListener = () => {};
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.heartbeatAcknowledged = true;
    this.initialize();
  }

  destroy() {
    clearTimeout(this.heartbeatTimer);
    clearTimeout(this.reconnectTimeout);
    this.socket.removeEventListener('open', this.openListener);
    this.socket.removeEventListener('message', this.messageListener);
    this.socket.removeEventListener('close', this.closeListener);
    this.socket.removeEventListener('error', this.errorListener);
    this.socket.close();
  }

  initialize() {
    this.socket = new WebSocket(SignallingServerConnection.kEndpoint);
    this.openListener = () => {
      console.log('<- websocket open');
      this._identify(this.uuid);
      this.heartbeatAcknowledged = true;
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = setTimeout(
        this._heartbeat.bind(this),
        SignallingServerConnection.kHeartbeatTimeout,
      );
    };
    this.messageListener = event => {
      let msg = JSON.parse(event.data);
      if (msg.event === 'signal' || msg.event === 'request_offer') {
        let from = msg.data.from;
        let data = msg.data.data;
        console.log('<- websocket message', from);
        this.fire('message', {
          event: msg.event,
          from: from,
          data: data,
        });
      } else if (msg.event === 'pong') {
        console.log('<- websocket pong');
        this.heartbeatAcknowledged = true;
      } else if (msg.event === 'reload') {
        if (window.location) {
          // TODO react-native ?
          window.location.reload();
        }
      }
    };
    this.closeListener = event => {
      console.log('<- websocket close', event);
      this.isConnected = false;
      clearTimeout(this.heartbeatTimer);
      this.reconnectTimer = setTimeout(
        this.initialize.bind(this),
        SignallingServerConnection.kReconnectInterval,
      );
    };
    this.errorListener = error => {
      console.log('<- websocket error', error);
      // TODO should anything happen here?
    };
    this.socket.addEventListener('open', this.openListener);
    this.socket.addEventListener('message', this.messageListener);
    this.socket.addEventListener('close', this.closeListener);
    this.socket.addEventListener('error', this.errorListener);
    // TODO other events?
  }

  requestOffer(id) {
    console.log('-> websocket request offer', id);
    let msg = JSON.stringify({
      event: 'request_offer',
      data: {
        to: id,
      },
    });
    if (!this.isConnected) {
      this.pendingSignals.push(msg);
    } else {
      this.socket.send(msg);
    }
  }

  assertControl() {
    console.log('-> assert control');
    let msg = JSON.stringify({
      event: 'assert_control',
    });
    if (!this.isConnected) {
      this.pendingSignals.push(msg);
    } else {
      this.socket.send(msg);
    }
  }

  signal(id, data) {
    console.log('-> websocket signal', id);
    let msg = JSON.stringify({
      event: 'signal',
      data: {
        to: id,
        data: data,
      },
    });
    if (!this.isConnected) {
      this.pendingSignals.push(msg);
    } else {
      this.socket.send(msg);
    }
  }

  _identify(uuid) {
    console.log('-> websocket identify');
    this.auth.currentUser.getIdToken(true).then(token => {
      this.socket.send(
        JSON.stringify({
          event: 'identify',
          data: {
            token: token,
            uuid: uuid,
          },
        }),
      );
      this.isConnected = true;
      for (var i in this.pendingSignals) {
        this.socket.send(this.pendingSignals[i]);
      }
      this.pendingSignals = [];
    });
  }

  _heartbeat() {
    if (!this.heartbeatAcknowledged) {
      console.log('<- websocket heartbeat missed');
      this.socket.close();
      return;
    }

    console.log('-> websocket ping');
    this.heartbeatAcknowledged = false;
    let msg = JSON.stringify({
      event: 'ping',
    });
    this.socket.send(msg);
    this.heartbeatTimer = setTimeout(
      this._heartbeat.bind(this),
      SignallingServerConnection.kHeartbeatTimeout,
    );
  }
}

SignallingServerConnection.kEndpoint = 'BLANK';
SignallingServerConnection.kHeartbeatTimeout = 30000;
SignallingServerConnection.kReconnectInterval = 5000;

export {SignallingServerConnection};
