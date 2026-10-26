import { RTCPeerConnection as NodePeerConnection, type RTCDataChannel as NodeDataChannel } from "werift";
import { LinkspanError } from "@jokoagent/linkspan-core";

/**
 * The host owns signaling, ICE configuration and endpoint authorization.
 * Load this separate Node engine only when selecting the WebRTC path.
 */
export function createNodeWebRtcPeer(configuration: RTCConfiguration = {}): RTCPeerConnection {
  if (configuration.certificates !== undefined) throw new LinkspanError("invalid_argument", "Node WebRTC uses its own ephemeral DTLS certificates.");
  const peer = new NodePeerConnection({
    iceServers: configuration.iceServers ?? [],
    ...(configuration.iceTransportPolicy === undefined ? {} : { iceTransportPolicy: configuration.iceTransportPolicy }),
    ...(configuration.bundlePolicy === undefined ? {} : { bundlePolicy: configuration.bundlePolicy })
  });
  const enforceStunConfiguration = (): void => {
    const connection = peer.sctp?.transport.iceTransport.connection;
    // The fixed engine supplies Google STUN when its parsed STUN option is
    // absent, including an explicit [] or TURN-only host configuration.
    // Keep that absence explicit before gathering; never replace a supplied
    // STUN server or modify the host's TURN credentials / ICE policy.
    if (connection !== undefined && connection.options.stunServer === undefined) delete connection.stunServer;
  };
  const setConfiguration = peer.setConfiguration.bind(peer);
  peer.setConfiguration = (...args: Parameters<typeof setConfiguration>) => { setConfiguration(...args); enforceStunConfiguration(); };
  const setLocalDescription = peer.setLocalDescription.bind(peer);
  peer.setLocalDescription = ((...args: Parameters<typeof setLocalDescription>) => { enforceStunConfiguration(); return setLocalDescription(...args); }) as typeof peer.setLocalDescription;
  const setRemoteDescription = peer.setRemoteDescription.bind(peer);
  peer.setRemoteDescription = async (...args: Parameters<typeof setRemoteDescription>) => { await setRemoteDescription(...args); enforceStunConfiguration(); };
  const decorated = new WeakSet<NodeDataChannel>();
  const decorate = (channel: NodeDataChannel): NodeDataChannel => {
    if (decorated.has(channel)) return channel;
    decorated.add(channel);
    const send = channel.send.bind(channel);
    channel.send = ((data: string | ArrayBuffer | ArrayBufferView): void => {
      if (typeof data === "string") send(data);
      else if (data instanceof ArrayBuffer) send(Buffer.from(data));
      else if (ArrayBuffer.isView(data)) send(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
      else throw new LinkspanError("invalid_argument", "The Node WebRTC adapter requires binary bytes or text.");
    }) as typeof channel.send;
    Object.defineProperty(channel, "binaryType", { value: "arraybuffer", writable: true, configurable: true });
    const emit = channel.emit.bind(channel);
    channel.emit = (name: string | symbol, ...args: unknown[]): boolean => {
      if (name === "message") {
        const event = args[0] as { data?: unknown } | undefined;
        if (event !== undefined && event.data instanceof Uint8Array) args[0] = { ...event, data: Uint8Array.from(event.data).buffer };
      }
      return emit(name, ...args);
    };
    const dtls = channel.sctp.transport;
    enforceStunConfiguration();
    Object.defineProperty(dtls, "getRemoteCertificates", { configurable: true, value: (): ArrayBuffer[] => {
      // Read the certificate accepted by the actual DTLS engine, never SDP.
      const certificate = dtls.dtls?.remoteCertificate;
      return certificate === undefined ? [] : [Uint8Array.from(certificate).buffer];
    } });
    return channel;
  };
  const create = peer.createDataChannel.bind(peer);
  peer.createDataChannel = (...args: Parameters<typeof create>) => decorate(create(...args));
  // The engine emits this event before both DOM callbacks and listeners.
  peer.onDataChannel.subscribe(decorate);
  return peer as unknown as RTCPeerConnection;
}
