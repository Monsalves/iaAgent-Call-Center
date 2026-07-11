import alawmulawPackage from "alawmulaw";

const { mulaw } = alawmulawPackage;

export function decodeTwilioPayload(base64Payload) {
  const mulawBuffer = Buffer.from(base64Payload, "base64");
  const pcmSamples = mulaw.decode(mulawBuffer);
  return Buffer.from(pcmSamples.buffer);
}

export function encodeTwilioPayload(pcmBuffer) {
  const pcmView = new Int16Array(
    pcmBuffer.buffer,
    pcmBuffer.byteOffset,
    Math.floor(pcmBuffer.byteLength / 2)
  );
  const mulawSamples = mulaw.encode(pcmView);
  return Buffer.from(mulawSamples).toString("base64");
}

export function resamplePcm16(pcmBuffer, inputRate, outputRate) {
  if (inputRate === outputRate) {
    return Buffer.from(pcmBuffer);
  }

  const input = new Int16Array(
    pcmBuffer.buffer,
    pcmBuffer.byteOffset,
    Math.floor(pcmBuffer.byteLength / 2)
  );
  const outputLength = Math.max(1, Math.round((input.length * outputRate) / inputRate));
  const output = new Int16Array(outputLength);

  for (let index = 0; index < outputLength; index += 1) {
    const position = (index * (input.length - 1)) / Math.max(outputLength - 1, 1);
    const leftIndex = Math.floor(position);
    const rightIndex = Math.min(leftIndex + 1, input.length - 1);
    const fraction = position - leftIndex;
    output[index] = Math.round(input[leftIndex] * (1 - fraction) + input[rightIndex] * fraction);
  }

  return Buffer.from(output.buffer);
}

export function bufferToBase64(pcmBuffer) {
  return Buffer.from(pcmBuffer).toString("base64");
}
