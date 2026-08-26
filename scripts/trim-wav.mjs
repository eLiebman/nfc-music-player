import { readFile, writeFile } from "node:fs/promises";

const SILENCE_THRESHOLD = 10 ** (-60 / 20);
const EDGE_PADDING_SECONDS = 0.02;

function findChunks(buffer) {
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Not a RIFF/WAVE file");
  }
  const chunks = [];
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + size;
    if (dataEnd > buffer.length) throw new Error(`Invalid ${id} WAV chunk size`);
    chunks.push({ id, offset, size, dataStart, dataEnd, paddedEnd: dataEnd + (size % 2) });
    offset = dataEnd + (size % 2);
  }
  return chunks;
}

function sampleReader(format, bitsPerSample) {
  if (format === 1 && bitsPerSample === 16) return (buffer, offset) => buffer.readInt16LE(offset) / 32768;
  if (format === 1 && bitsPerSample === 24) return (buffer, offset) => buffer.readIntLE(offset, 3) / 8388608;
  if (format === 1 && bitsPerSample === 32) return (buffer, offset) => buffer.readInt32LE(offset) / 2147483648;
  if (format === 3 && bitsPerSample === 32) return (buffer, offset) => buffer.readFloatLE(offset);
  if (format === 3 && bitsPerSample === 64) return (buffer, offset) => buffer.readDoubleLE(offset);
  throw new Error(`Unsupported WAV encoding: format ${format}, ${bitsPerSample}-bit`);
}

export function trimWavBuffer(buffer) {
  const chunks = findChunks(buffer);
  const fmt = chunks.find((chunk) => chunk.id === "fmt ");
  const data = chunks.find((chunk) => chunk.id === "data");
  if (!fmt || fmt.size < 16 || !data) throw new Error("WAV requires fmt and data chunks");

  const format = buffer.readUInt16LE(fmt.dataStart);
  const channels = buffer.readUInt16LE(fmt.dataStart + 2);
  const sampleRate = buffer.readUInt32LE(fmt.dataStart + 4);
  const blockAlign = buffer.readUInt16LE(fmt.dataStart + 12);
  const bitsPerSample = buffer.readUInt16LE(fmt.dataStart + 14);
  const bytesPerSample = bitsPerSample / 8;
  if (!channels || !sampleRate || !blockAlign || blockAlign !== channels * bytesPerSample) {
    throw new Error("Unsupported WAV channel layout");
  }
  const readSample = sampleReader(format, bitsPerSample);
  const frameCount = Math.floor(data.size / blockAlign);
  const frameIsAudible = (frame) => {
    const frameOffset = data.dataStart + frame * blockAlign;
    for (let channel = 0; channel < channels; channel += 1) {
      const value = readSample(buffer, frameOffset + channel * bytesPerSample);
      if (Number.isFinite(value) && Math.abs(value) > SILENCE_THRESHOLD) return true;
    }
    return false;
  };

  let lastAudible = frameCount - 1;
  while (lastAudible >= 0 && !frameIsAudible(lastAudible)) lastAudible -= 1;
  if (lastAudible < 0) return { buffer, changed: false, reason: "entire file is silent" };

  const paddingFrames = Math.round(sampleRate * EDGE_PADDING_SECONDS);
  const startFrame = 0;
  const endFrame = Math.min(frameCount, lastAudible + 1 + paddingFrames);
  if (startFrame === 0 && endFrame === frameCount) {
    return { buffer, changed: false, trimmedStartSeconds: 0, trimmedEndSeconds: 0 };
  }

  const trimmedData = buffer.subarray(
    data.dataStart + startFrame * blockAlign,
    data.dataStart + endFrame * blockAlign,
  );
  const before = buffer.subarray(0, data.offset);
  const after = buffer.subarray(data.paddedEnd);
  const dataHeader = Buffer.alloc(8);
  dataHeader.write("data", 0, "ascii");
  dataHeader.writeUInt32LE(trimmedData.length, 4);
  const padding = trimmedData.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0);
  const output = Buffer.concat([before, dataHeader, trimmedData, padding, after]);
  output.writeUInt32LE(output.length - 8, 4);
  return {
    buffer: output,
    changed: true,
    trimmedStartSeconds: 0,
    trimmedEndSeconds: (frameCount - endFrame) / sampleRate,
  };
}

export async function trimWavFile(inputPath, outputPath) {
  const result = trimWavBuffer(await readFile(inputPath));
  await writeFile(outputPath, result.buffer);
  return result;
}
