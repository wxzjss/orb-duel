/* tests/nethelp.js —— v3.1 联机 stub 工厂（QA 从 selftest.js T19/T20 共享段抽取复用）
 * mkNetPair()：返回 { mkPC, created, mirrors, shake }
 *   mkPC(isGuest)：内存 RTCPeerConnection stub（offer/answer SDP + datachannel 镜像配对）
 *   created/mirrors：host/guest 侧创建的 RTCDataChannel stub
 *   shake()：握手完成模拟（配对 DC 全部 open）
 * _mkNetDC(name, opts)：单条 DC stub（connecting→open 生命周期） */
'use strict';
function _mkNetDC(name, opts) {
  const dc = { name, opts, readyState: 'connecting', _peer: null, _sends: [], _ls: {},
    send(s) { dc._sends.push(s); if (dc._peer) (dc._peer._ls.message || []).forEach((f) => f({ data: s })); },
    close() { dc.readyState = 'closed'; (dc._ls.close || []).forEach((f) => f()); },
    addEventListener(ev, fn) { (dc._ls[ev] = dc._ls[ev] || []).push(fn); },
    _setOpen() { dc.readyState = 'open'; (dc._ls.open || []).forEach((f) => f()); } };
  return dc;
}
function mkNetPair() {
  const created = [], mirrors = [];
  let useq = 0;
  const mkPC = (isGuest) => {
    const batch = [];                    // 本 PC（=本张 offer）的 DC 批次
    const pc = { iceGatheringState: 'complete', localDescription: null, remoteDescription: null, _ls: {},
      addEventListener(ev, fn) { (pc._ls[ev] = pc._ls[ev] || []).push(fn); },
      _fire(ev, arg) { (pc._ls[ev] || []).forEach((f) => f(arg)); },
      createDataChannel(name, opts) { const dc = _mkNetDC(name, opts); if (!isGuest) { created.push(dc); batch.push(dc); } return dc; },
      async createOffer() {
        useq++;
        const u = 'U' + useq;
        for (const dc of batch) dc._ufrag = u;          // host DC 标记所属 offer
        return { type: 'offer', sdp:
          'v=0\r\na=ice-ufrag:' + u + '\r\na=ice-pwd:P' + useq +
          '\r\na=fingerprint:sha-256 AA:' + (10 + useq) +
          '\r\n\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n' };
      },
      async createAnswer() {
        useq += 100;
        return { type: 'answer', sdp:
          'v=0\r\na=ice-ufrag:U' + useq + '\r\na=ice-pwd:P' + useq +
          '\r\na=fingerprint:sha-256 AA:' + (10 + useq) +
          '\r\n\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n' };
      },
      async setLocalDescription(d) { pc.localDescription = d; },
      async setRemoteDescription(d) {
        pc.remoteDescription = d;
        /* 真实 WebRTC：访客按 offer SDP 建对端通道——stub 以 ufrag 匹配 host DC 造镜像 */
        if (isGuest) {
          const u = /ice-ufrag:(\S+)/.exec(d.sdp)[1];
          for (const hdc of created) {
            if (hdc._ufrag !== u || hdc._peer) continue;
            const gdc = _mkNetDC(hdc.name);
            hdc._peer = gdc; gdc._peer = hdc;
            mirrors.push(gdc);
            pc._fire('datachannel', { channel: gdc });
          }
        }
      } };
    return pc;
  };
  /* 握手完成模拟：只 open 已配对（有镜像）的 DC——未消耗邀请码的 DC 保持 connecting */
  const shake = () => {
    for (const dc of created) if (dc._peer) { dc._setOpen(); dc._peer._setOpen(); }
    for (const m of mirrors) m._setOpen();
  };
  return { mkPC, created, mirrors, shake };
}
module.exports = { _mkNetDC, mkNetPair };
