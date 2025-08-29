const mediasoup = require('mediasoup');
const WebSocket = require('ws');

const wss = new WebSocket.Server({ port: 3000 });
let worker, router;
const peers = new Map(); // peerId → { transports, producers, consumers }

(async () => {
    worker = await mediasoup.createWorker();
    router = await worker.createRouter({
        mediaCodecs: [
            {
                kind: 'audio',
                mimeType: 'audio/opus',
                clockRate: 48000,
                channels: 2
            },
            {
                kind: 'video',
                mimeType: 'video/VP8',
                clockRate: 90000
            }
        ]
    });
})();

wss.on('connection', ws => {
    const peerId = crypto.randomUUID();
    peers.set(peerId, { transports: [], producers: [], consumers: [] });

    ws.on('message', async msg => {
        const { action, data } = JSON.parse(msg);
        const peer = peers.get(peerId);

        if (action === 'getRouterRtpCapabilities') {
            ws.send(JSON.stringify({
                action: 'routerRtpCapabilities',
                data: router.rtpCapabilities
            }));
        }

        if (action === 'createTransport') {
            const transport = await router.createWebRtcTransport({
                listenIps: [{ ip: '0.0.0.0', announcedIp: 'YOUR_PUBLIC_IP' }],
                enableUdp: true,
                enableTcp: true,
                preferUdp: true
            });

            peer.transports.push(transport);

            ws.send(JSON.stringify({
                action: 'transportCreated',
                data: {
                    id: transport.id,
                    iceParameters: transport.iceParameters,
                    iceCandidates: transport.iceCandidates,
                    dtlsParameters: transport.dtlsParameters
                }
            }));

            transport.on('dtlsstatechange', state => {
                if (state === 'closed') transport.close();
            });
        }

        if (action === 'connectTransport') {
            const transport = peer.transports.find(t => t.id === data.transportId);
            await transport.connect({ dtlsParameters: data.dtlsParameters });
        }

        if (action === 'produce') {
            const transport = peer.transports.find(t => t.id === data.transportId);
            const producer = await transport.produce({
                kind: data.kind,
                rtpParameters: data.rtpParameters
            });

            peer.producers.push(producer);

            ws.send(JSON.stringify({
                action: 'produced',
                data: { id: producer.id }
            }));
        }

        if (action === 'consume') {
            const transport = peer.transports.find(t => t.id === data.transportId);
            const producerPeer = peers.get(data.producerPeerId);
            const producer = producerPeer.producers.find(p => p.id === data.producerId);

            const consumer = await transport.consume({
                producerId: producer.id,
                rtpCapabilities: data.rtpCapabilities,
                paused: false
            });

            peer.consumers.push(consumer);

            ws.send(JSON.stringify({
                action: 'consumed',
                data: {
                    id: consumer.id,
                    kind: consumer.kind,
                    rtpParameters: consumer.rtpParameters
                }
            }));
        }
    });

    ws.on('close', () => {
        const peer = peers.get(peerId);
        peer.transports.forEach(t => t.close());
        peer.producers.forEach(p => p.close());
        peer.consumers.forEach(c => c.close());
        peers.delete(peerId);
    });
});