import { Boom } from '@hapi/boom';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';

const runFfmpeg = (input, args) => new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', ...args, 'pipe:1'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const outChunks = [];
    const errChunks = [];
    proc.stdout.on('data', chunk => outChunks.push(chunk));
    proc.stderr.on('data', chunk => errChunks.push(chunk));
    proc.on('error', err => reject(new Boom(`ffmpeg failed to start: ${err.message}`, { statusCode: 500 })));
    proc.on('close', code => {
        if (code !== 0) {
            reject(new Boom(`ffmpeg exited with code ${code}: ${Buffer.concat(errChunks).toString('utf8').slice(0, 500)}`, { statusCode: 500 }));
            return;
        }
        resolve(Buffer.concat(outChunks));
    });
    proc.stdin.on('error', () => { });
    proc.stdin.end(input);
});
export const isLikelyVideoBuffer = (buffer) => {
    if (!Buffer.isBuffer(buffer) || buffer.length < 4) {
        return false;
    }
    const header = buffer.subarray(0, 16).toString('ascii');
    if (header.startsWith('RIFF') && /AVI|WEBM/.test(header)) {
        return true;
    }
    if (buffer.subarray(0, 4).toString('hex') === '1a45dfa3') {
        return true;
    }
    const ftyp = buffer.toString('ascii', 4, 12);
    if (buffer.toString('ascii', 0, 4) === 'ftyp' || /^(ftyp)/.test(buffer.toString('ascii', 0, 8))) {
        return /mp4|isom|M4V|M4A|qt\s/.test(ftyp);
    }
    return false;
};
export const convertToWebp = async (buffer, { animated = false, quality = 60 } = {}) => {
    const scalePad = "scale='min(512,iw)':'min(512,ih)':force_original_aspect_ratio=decrease,format=rgba,pad=512:512:-1:-1:color=#00000000";
    const args = animated
        ? ['-vf', `${scalePad},fps=15`, '-loop', '0', '-preset', 'default', '-an', '-vsync', '0', '-vcodec', 'libwebp', '-q:v', String(quality), '-f', 'webp']
        : ['-vf', `${scalePad}`, '-vframes', '1', '-vcodec', 'libwebp', '-q:v', String(quality), '-f', 'webp'];
    return runFfmpeg(buffer, args);
};
export const convertToTrayIcon = async (buffer) => {
    const scalePad = "scale='min(96,iw)':'min(96,ih)':force_original_aspect_ratio=decrease,format=rgba,pad=96:96:-1:-1:color=#00000000";
    const args = ['-vf', scalePad, '-vframes', '1', '-vcodec', 'png', '-f', 'image2'];
    return runFfmpeg(buffer, args);
};
const readChunks = (buf) => {
    const chunks = [];
    let offset = 12;
    while (offset + 8 <= buf.length) {
        const fourCC = buf.toString('ascii', offset, offset + 4);
        const size = buf.readUInt32LE(offset + 4);
        const dataStart = offset + 8;
        const data = buf.subarray(dataStart, dataStart + size);
        chunks.push({ fourCC, data });
        offset = dataStart + size + (size % 2);
    }
    return chunks;
};
const buildChunk = (fourCC, data) => {
    const header = Buffer.alloc(8);
    header.write(fourCC, 0, 4, 'ascii');
    header.writeUInt32LE(data.length, 4);
    const pad = data.length % 2 === 1 ? Buffer.from([0]) : Buffer.alloc(0);
    return Buffer.concat([header, data, pad]);
};
const buildExifChunkData = (json) => {
    const header = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00]);
    const payload = Buffer.from(JSON.stringify(json), 'utf8');
    header.writeUInt32LE(payload.length, 14);
    return Buffer.concat([header, payload]);
};
export const writeExifToWebp = (webpBuffer, { packId, packName = '', publisher = '', emojis = [], isAvatar = false } = {}) => {
    if (webpBuffer.toString('ascii', 0, 4) !== 'RIFF' || webpBuffer.toString('ascii', 8, 12) !== 'WEBP') {
        throw new Boom('writeExifToWebp: not a valid webp buffer', { statusCode: 400 });
    }
    const chunks = readChunks(webpBuffer);
    const exifData = buildExifChunkData({
        'sticker-pack-id': packId || randomUUID(),
        'sticker-pack-name': packName,
        'sticker-pack-publisher': publisher,
        emojis: emojis.length ? emojis : ['🤖'],
        'is-avatar-sticker': isAvatar ? 1 : 0
    });
    let vp8x = chunks.find(c => c.fourCC === 'VP8X');
    const otherChunks = chunks.filter(c => c.fourCC !== 'VP8X' && c.fourCC !== 'EXIF');
    if (!vp8x) {
        const img = otherChunks.find(c => c.fourCC === 'VP8 ' || c.fourCC === 'VP8L');
        if (!img) {
            throw new Boom('writeExifToWebp: no VP8/VP8L image data found', { statusCode: 400 });
        }
        let width;
        let height;
        if (img.fourCC === 'VP8 ') {
            width = (img.data.readUInt16LE(6) & 0x3fff);
            height = (img.data.readUInt16LE(8) & 0x3fff);
        }
        else {
            const b = img.data;
            width = 1 + (((b[2] & 0x3f) << 8) | b[1]);
            height = 1 + (((b[4] & 0xf) << 10) | (b[3] << 2) | ((b[2] & 0xc0) >> 6));
        }
        const flags = Buffer.alloc(4);
        flags[0] = 0x08;
        const dims = Buffer.alloc(6);
        dims.writeUIntLE(width - 1, 0, 3);
        dims.writeUIntLE(height - 1, 3, 3);
        vp8x = { fourCC: 'VP8X', data: Buffer.concat([flags, dims]) };
    }
    else {
        const flagsByte = vp8x.data[0] | 0x08;
        vp8x = { fourCC: 'VP8X', data: Buffer.concat([Buffer.from([flagsByte]), vp8x.data.subarray(1)]) };
    }
    const rebuilt = [vp8x, ...otherChunks, { fourCC: 'EXIF', data: exifData }];
    const chunkBuffers = rebuilt.map(c => buildChunk(c.fourCC, c.data));
    const payload = Buffer.concat(chunkBuffers);
    const riffSize = 4 + payload.length;
    const out = Buffer.alloc(8 + 4 + payload.length);
    out.write('RIFF', 0, 4, 'ascii');
    out.writeUInt32LE(riffSize, 4);
    out.write('WEBP', 8, 4, 'ascii');
    payload.copy(out, 12);
    return out;
};
export const makeSticker = async (buffer, { pack = '', author = '', emojis = [], isPrivate = false, animated = false, quality = 60 } = {}) => {
    const shouldAnimate = animated || isLikelyVideoBuffer(buffer);
    const webp = await convertToWebp(buffer, { animated: shouldAnimate, quality });
    return writeExifToWebp(webp, { packName: pack, publisher: author, emojis, isAvatar: isPrivate });
};
