import fs from "fs/promises";

/**
 * Reads how long an MP4 or MOV video is, from its "mvhd" header, without any extra software.
 * Returns null when the file isn't a readable MP4/MOV.
 */
export async function videoDurationSeconds(file: string): Promise<number | null> {
    const handle = await fs.open(file, "r");
    try {
        const { size } = await handle.stat();
        const header = Buffer.alloc(16);

        // Walks the boxes in [start, end) and returns where the named one's content begins and ends.
        const find = async (name: string, start: number, end: number) => {
            let at = start;
            while (at + 8 <= end) {
                await handle.read(header, 0, 16, at);
                let boxSize = header.readUInt32BE(0);
                const type = header.toString("latin1", 4, 8);
                let headerSize = 8;
                if (boxSize === 1) {
                    boxSize = Number(header.readBigUInt64BE(8));
                    headerSize = 16;
                } else if (boxSize === 0) {
                    boxSize = end - at;
                }
                if (boxSize < headerSize) return null;
                if (type === name) return { start: at + headerSize, end: at + boxSize };
                at += boxSize;
            }
            return null;
        };

        const moov = await find("moov", 0, size);
        if (!moov) return null;
        const mvhd = await find("mvhd", moov.start, moov.end);
        if (!mvhd) return null;
        const body = Buffer.alloc(32);
        await handle.read(body, 0, 32, mvhd.start);
        const version = body.readUInt8(0);
        const timescale = version === 1 ? body.readUInt32BE(20) : body.readUInt32BE(12);
        const duration = version === 1 ? Number(body.readBigUInt64BE(24)) : body.readUInt32BE(16);
        return timescale > 0 ? duration / timescale : null;
    } catch {
        return null;
    } finally {
        await handle.close();
    }
}
