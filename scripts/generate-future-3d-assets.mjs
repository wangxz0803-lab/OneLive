import { createHmac, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

const HOST = 'ai3d.tencentcloudapi.com';
const SERVICE = 'ai3d';
const VERSION = '2025-05-13';
const REGION = process.env.TENCENT_REGION || 'ap-guangzhou';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function hmac(key, value, encoding) {
  return createHmac('sha256', key).update(value).digest(encoding);
}

function parseCsvLine(line) {
  const values = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"' && line[index + 1] === '"') {
      current += '"';
      index += 1;
    } else if (character === '"') quoted = !quoted;
    else if (character === ',' && !quoted) {
      values.push(current);
      current = '';
    } else current += character;
  }
  values.push(current);
  return values.map((value) => value.trim());
}

async function readCredential(csvPath) {
  const lines = (await readFile(csvPath, 'utf8')).replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) throw new Error('Credential CSV does not contain a data row.');
  const headers = parseCsvLine(lines[0]);
  const values = parseCsvLine(lines[1]);
  const row = Object.fromEntries(headers.map((header, index) => [header, values[index]]));
  if (!row.SecretId || !row.SecretKey) throw new Error('Credential CSV must contain SecretId and SecretKey.');
  return row;
}

async function callTencent(action, payload, credential) {
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const contentType = 'application/json; charset=utf-8';
  const canonicalHeaders = `content-type:${contentType}\nhost:${HOST}\n`;
  const signedHeaders = 'content-type;host';
  const canonicalRequest = ['POST', '/', '', canonicalHeaders, signedHeaders, sha256(body)].join('\n');
  const scope = `${date}/${SERVICE}/tc3_request`;
  const stringToSign = ['TC3-HMAC-SHA256', timestamp, scope, sha256(canonicalRequest)].join('\n');
  const secretDate = hmac(`TC3${credential.SecretKey}`, date);
  const secretService = hmac(secretDate, SERVICE);
  const secretSigning = hmac(secretService, 'tc3_request');
  const signature = hmac(secretSigning, stringToSign, 'hex');
  const authorization = `TC3-HMAC-SHA256 Credential=${credential.SecretId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const response = await fetch(`https://${HOST}`, {
    method: 'POST',
    headers: {
      Authorization: authorization,
      'Content-Type': contentType,
      Host: HOST,
      'X-TC-Action': action,
      'X-TC-Region': REGION,
      'X-TC-Timestamp': String(timestamp),
      'X-TC-Version': VERSION,
    },
    body,
  });
  const result = await response.json();
  if (!response.ok || result.Response?.Error) {
    const error = result.Response?.Error;
    throw new Error(`${error?.Code || response.status}: ${error?.Message || response.statusText}`);
  }
  return result.Response;
}

async function main() {
  const [command, credentialPath, ...args] = process.argv.slice(2);
  if (!command || !credentialPath) {
    throw new Error('Usage: node generate-future-3d-assets.mjs <pro|pro-multiview|pro-status|profile|profile-status|rig|rig-status|motion|motion-retarget|motion-status> <SecretKey.csv> [...args]');
  }
  const credential = await readCredential(credentialPath);
  let result;
  if (command === 'pro-multiview') {
    const [frontPath, leftPath, rightPath, backPath, model = '3.1'] = args;
    if (!frontPath || !leftPath || !rightPath || !backPath) {
      throw new Error('pro-multiview requires front, left, right, and back image paths.');
    }
    const [front, left, right, back] = await Promise.all(
      [frontPath, leftPath, rightPath, backPath].map(async (path) => (await readFile(path)).toString('base64')),
    );
    const response = await callTencent('SubmitHunyuanTo3DProJob', {
      Model: model,
      ImageBase64: front,
      MultiViewImages: [
        { ViewType: 'left', ViewImageBase64: left },
        { ViewType: 'right', ViewImageBase64: right },
        { ViewType: 'back', ViewImageBase64: back },
      ],
      EnablePBR: true,
      FaceCount: 180000,
      GenerateType: 'Normal',
    }, credential);
    result = {
      operation: 'pro-multiview',
      inputs: [frontPath, leftPath, rightPath, backPath].map((path) => basename(path)),
      model,
      jobId: response.JobId,
      requestId: response.RequestId,
    };
  } else if (command === 'pro') {
    const [imagePath, model = '3.1', resultFormat = 'FBX'] = args;
    if (!imagePath) throw new Error('pro requires a clean single-subject reference image.');
    const imageBase64 = (await readFile(imagePath)).toString('base64');
    const response = await callTencent('SubmitHunyuanTo3DProJob', {
      Model: model,
      ImageBase64: imageBase64,
      EnablePBR: true,
      FaceCount: 180000,
      GenerateType: 'Normal',
      ResultFormat: resultFormat,
    }, credential);
    result = {
      operation: 'pro',
      input: basename(imagePath),
      model,
      resultFormat,
      jobId: response.JobId,
      requestId: response.RequestId,
    };
  } else if (command === 'pro-status') {
    const [jobId] = args;
    result = await callTencent('QueryHunyuanTo3DProJob', { JobId: jobId }, credential);
  } else if (command === 'profile') {
    const [photoPath, template = 'manstandpose2'] = args;
    if (!photoPath) throw new Error('profile requires a photo path.');
    const profile = (await readFile(photoPath)).toString('base64');
    result = await callTencent('SubmitProfileTo3DJob', { Profile: { Base64: profile }, Template: template }, credential);
    result = { operation: 'profile', input: basename(photoPath), template, jobId: result.JobId, requestId: result.RequestId };
  } else if (command === 'profile-status') {
    const [jobId] = args;
    result = await callTencent('DescribeProfileTo3DJob', { JobId: jobId }, credential);
  } else if (command === 'profile-download') {
    const [jobId, outputDirectory] = args;
    if (!outputDirectory) throw new Error('profile-download requires an output directory.');
    const response = await callTencent('DescribeProfileTo3DJob', { JobId: jobId }, credential);
    if (response.Status !== 'DONE') throw new Error(`Profile job is not complete: ${response.Status}`);
    await mkdir(outputDirectory, { recursive: true });
    const files = [];
    for (const file of response.ResultFile3Ds || []) {
      const name = basename(new URL(file.Url).pathname);
      const download = await fetch(file.Url);
      if (!download.ok) throw new Error(`Download failed for ${name}: ${download.status}`);
      const bytes = Buffer.from(await download.arrayBuffer());
      await writeFile(join(outputDirectory, name), bytes);
      files.push({ type: file.Type, name, bytes: bytes.length });
    }
    result = { operation: 'profile-download', jobId, files };
  } else if (command === 'rig') {
    const [fileUrl, type = 'FBX', motion = '26'] = args;
    if (!fileUrl) throw new Error('rig requires a public model URL.');
    const response = await callTencent('SubmitAutoRiggingJob', { File3D: { Url: fileUrl, Type: type }, MotionType: Number(motion) }, credential);
    result = { operation: 'rig', motion: Number(motion), jobId: response.JobId, requestId: response.RequestId };
  } else if (command === 'rig-status') {
    const [jobId] = args;
    result = await callTencent('DescribeAutoRiggingJob', { JobId: jobId }, credential);
  } else if (command === 'motion') {
    const [duration = '8'] = args;
    const prompt = 'A presenter stands in place, speaks and makes small natural explanatory hand gestures.';
    const response = await callTencent('SubmitHunyuanTo3DMotionJob', {
      Prompt: prompt,
      Model: 'HY-Motion-1.0',
      Duration: Number(duration),
      EnableMesh: true,
      EnableRewrite: true,
      EnableDurationEst: false,
    }, credential);
    result = { operation: 'motion', duration: Number(duration), jobId: response.JobId, requestId: response.RequestId };
  } else if (command === 'motion-retarget') {
    const [fileUrl, type = 'FBX', duration = '8'] = args;
    if (!fileUrl) throw new Error('motion-retarget requires a public model URL.');
    const prompt = 'A male livestream host stands in place, speaks to camera, and uses small natural hand gestures with relaxed idle movement.';
    const response = await callTencent('SubmitHunyuanTo3DMotionJob', {
      Prompt: prompt,
      Model: 'HY-Motion-1.0',
      RetargetFile: { Url: fileUrl, Type: type },
      Duration: Number(duration),
      EnableMesh: true,
      EnableRewrite: true,
      EnableDurationEst: false,
    }, credential);
    result = { operation: 'motion-retarget', duration: Number(duration), jobId: response.JobId, requestId: response.RequestId };
  } else if (command === 'motion-status') {
    const [jobId] = args;
    result = await callTencent('DescribeHunyuanTo3DMotionJob', { JobId: jobId }, credential);
  } else throw new Error(`Unknown command: ${command}`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
