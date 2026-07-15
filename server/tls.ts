import { promises as fs } from 'node:fs';
import type { ServerOptions } from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { generate } from 'selfsigned';

const CERT_DIRECTORY = 'certs';
const KEY_FILE = 'onelive-key.pem';
const CERT_FILE = 'onelive-cert.pem';
const META_FILE = 'onelive-cert.json';

export const findLanAddresses = (): string[] => {
  const addresses = new Set<string>();

  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal || entry.address.startsWith('169.254.')) continue;
      addresses.add(entry.address);
    }
  }

  return [...addresses].sort((left, right) => {
    const leftPrivate = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(left);
    const rightPrivate = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(right);
    return Number(rightPrivate) - Number(leftPrivate) || left.localeCompare(right);
  });
};

const sameStringArray = (left: unknown, right: string[]): boolean =>
  Array.isArray(left) &&
  left.length === right.length &&
  left.every((item, index) => item === right[index]);

export const loadOrCreateCertificate = async (
  rootDirectory: string,
  lanAddresses: string[],
): Promise<ServerOptions> => {
  const certificateDirectory = path.join(rootDirectory, CERT_DIRECTORY);
  const keyPath = path.join(certificateDirectory, KEY_FILE);
  const certificatePath = path.join(certificateDirectory, CERT_FILE);
  const metadataPath = path.join(certificateDirectory, META_FILE);
  const hostname = os.hostname();
  const certificateAddresses = [...new Set(lanAddresses)].sort();

  try {
    const [key, cert, metadataText] = await Promise.all([
      fs.readFile(keyPath, 'utf8'),
      fs.readFile(certificatePath, 'utf8'),
      fs.readFile(metadataPath, 'utf8'),
    ]);
    const metadata = JSON.parse(metadataText) as { hostname?: unknown; addresses?: unknown };
    if (metadata.hostname === hostname && sameStringArray(metadata.addresses, certificateAddresses)) {
      return { key, cert };
    }
  } catch {
    // The first demo run, a changed LAN address, or a partial cert all regenerate safely.
  }

  await fs.mkdir(certificateDirectory, { recursive: true });
  const altNames: Array<
    { type: 2; value: string } | { type: 7; ip: string }
  > = [
    { type: 2, value: 'localhost' },
    { type: 2, value: hostname },
    { type: 7, ip: '127.0.0.1' },
    { type: 7, ip: '::1' },
    ...certificateAddresses.map((ip): { type: 7; ip: string } => ({ type: 7, ip })),
  ];
  const pems = await generate([{ name: 'commonName', value: 'OneLive Local Demo' }], {
    algorithm: 'sha256',
    keySize: 2048,
    notAfterDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames },
    ],
  });

  await Promise.all([
    fs.writeFile(keyPath, pems.private, { encoding: 'utf8', mode: 0o600 }),
    fs.writeFile(certificatePath, pems.cert, 'utf8'),
    fs.writeFile(
      metadataPath,
      JSON.stringify({ hostname, addresses: certificateAddresses }, null, 2),
      'utf8',
    ),
  ]);

  return { key: pems.private, cert: pems.cert };
};

