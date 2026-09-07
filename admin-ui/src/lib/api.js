import { originBase } from './format.js';

export async function gateway(settings, body) {
  const res = await fetch(`${originBase(settings)}/gateway`, {
    method: 'POST',
    headers: requestHeaders(settings),
    body: JSON.stringify(body)
  });
  return readJson(res);
}

export async function ping(settings) {
  const res = await fetch(`${originBase(settings)}/ping`);
  return readJson(res);
}

export function uploadPresignedFile({ uploadUrl, method = 'PUT', headers = {}, file, onProgress }) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open(method, uploadUrl, true);
    Object.entries(headers).forEach(([name, value]) => request.setRequestHeader(name, value));
    request.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable && onProgress) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    });
    request.addEventListener('load', () => {
      if (request.status >= 200 && request.status < 300) {
        onProgress?.(100);
        resolve({ status: 'uploaded' });
      } else {
        reject(new Error(`S3 upload failed with HTTP ${request.status}`));
      }
    });
    request.addEventListener('error', () => reject(new Error('S3 upload failed. Check the bucket CORS policy and network connection.')));
    request.addEventListener('abort', () => reject(new Error('S3 upload was cancelled.')));
    request.send(file);
  });
}

function requestHeaders(settings) {
  const headers = { 'content-type': 'application/json' };
  if (settings.accessKey) headers['x-access-key'] = settings.accessKey;
  return headers;
}

async function readJson(res) {
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch (_) {
    data = { status: res.ok ? 'success' : 'error', body: text };
  }
  if (!res.ok || data.status === 'error') {
    throw new Error(data.error || data.message || data.body || `HTTP ${res.status}`);
  }
  return data;
}
