const http = require("http");
const os = require("os");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

loadEnvFile(path.join(__dirname, ".env"));

let initializeFirebaseApp = null;
let getFirebaseApps = null;
let firebaseCert = null;
let getFirebaseFirestore = null;

try {
  ({ initializeApp: initializeFirebaseApp, getApps: getFirebaseApps, cert: firebaseCert } =
    require("firebase-admin/app"));
  ({ getFirestore: getFirebaseFirestore } = require("firebase-admin/firestore"));
} catch (error) {
  // Firebase is optional during local setup until dependencies and credentials are provided.
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const content = fs.readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    if (!key || process.env[key] !== undefined) {
      continue;
    }

    let value = line.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const API_KEY =
  process.env.GOOGLE_DRIVE_API_KEY || "AIzaSyCPrDluLv5ryZ2f-5WRiSGokJHRVeuGqe8";
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const REMOTE_CODES_FILE = path.join(DATA_DIR, "remote-links.txt");
const CODE_EXPIRY_MS = 2 * 24 * 60 * 60 * 1000;
const FIREBASE_COLLECTION = process.env.FIREBASE_PAIRING_COLLECTION || "pairingCodes";

const IMAGE_MIME_PREFIX = "image/";
const VIDEO_MIME_PREFIX = "video/";
const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
let firestoreDb = null;

const DRIVE_LINK_ACCESS_ERROR =
  "We couldn’t open that Google Drive folder. Make sure the link is correct and the folder is shared as 'Anyone with the link' with Viewer access, then try again.";

function ensureDataStore() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  if (!fs.existsSync(REMOTE_CODES_FILE)) {
    fs.writeFileSync(REMOTE_CODES_FILE, "", "utf8");
  }
}

function readRemoteMappings() {
  ensureDataStore();
  const content = fs.readFileSync(REMOTE_CODES_FILE, "utf8");

  return content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [code, url, createdAt, permanentFlag] = line.split("\t");
      return { code, url, createdAt, permanent: permanentFlag === "1" };
    });
}

function writeRemoteMappings(mappings) {
  ensureDataStore();
  const body = mappings
    .map((entry) =>
      [entry.code, entry.url || "", entry.createdAt || "", entry.permanent ? "1" : "0"].join("\t")
    )
    .join("\n");
  fs.writeFileSync(REMOTE_CODES_FILE, body ? `${body}\n` : "", "utf8");
}

function generateRemoteCode() {
  return generateNumericCode(6);
}

function generatePermanentRemoteCode() {
  return generateNumericCode(9);
}

function generateNumericCode(length) {
  const mappings = readRemoteMappings();
  let code = "";

  do {
    code = Array.from({ length }, () => Math.floor(Math.random() * 10)).join("");
  } while (mappings.some((entry) => entry.code === code));

  return code;
}

async function generateUniqueRemoteCode(codeExists, createCode = generateRemoteCode) {
  let code = "";

  do {
    code = createCode();
  } while (await codeExists(code));

  return code;
}

function normalizeRemoteUrl(url) {
  return String(url || "").trim();
}

function getFirebaseServiceAccount() {
  const json = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const base64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  const jsonPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;

  if (!json && !base64 && !jsonPath) {
    return null;
  }

  const parsed = JSON.parse(
    json ||
      (jsonPath
        ? fs.readFileSync(path.resolve(jsonPath), "utf8")
        : Buffer.from(base64, "base64").toString("utf8"))
  );

  if (parsed.private_key) {
    parsed.private_key = parsed.private_key.replace(/\\n/g, "\n");
  }

  return parsed;
}

function getFirestoreDb() {
  if (!initializeFirebaseApp || !getFirebaseFirestore) {
    return null;
  }

  if (firestoreDb) {
    return firestoreDb;
  }

  if (!getFirebaseApps().length) {
    const serviceAccount = getFirebaseServiceAccount();

    if (serviceAccount) {
      initializeFirebaseApp({
        credential: firebaseCert(serviceAccount),
        projectId: serviceAccount.project_id || process.env.FIREBASE_PROJECT_ID,
      });
    } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      initializeFirebaseApp({
        projectId: process.env.FIREBASE_PROJECT_ID,
      });
    } else {
      return null;
    }
  }

  firestoreDb = getFirebaseFirestore();
  return firestoreDb;
}

function isExpired(createdAt) {
  const timestamp = Date.parse(createdAt || "");
  if (Number.isNaN(timestamp)) {
    return true;
  }
  return Date.now() - timestamp > CODE_EXPIRY_MS;
}

function isEntryExpired(entry) {
  if (entry?.permanent) {
    return false;
  }
  return isExpired(entry?.createdAt);
}

function pruneExpiredMappings() {
  const mappings = readRemoteMappings();
  const activeMappings = mappings.filter((entry) => !isEntryExpired(entry));

  if (activeMappings.length !== mappings.length) {
    writeRemoteMappings(activeMappings);
  }

  return activeMappings;
}

async function writeRemoteLinkToStore(url, permanent = false) {
  const normalizedUrl = normalizeRemoteUrl(url);
  const db = getFirestoreDb();

  if (!db) {
    const mappings = pruneExpiredMappings();
    const existingEntry = mappings.find(
      (entry) => normalizeRemoteUrl(entry.url) === normalizedUrl && Boolean(entry.permanent) === permanent
    );

    if (existingEntry) {
      return { success: true, code: existingEntry.code, reused: true, store: "file" };
    }

    const code = permanent ? generatePermanentRemoteCode() : generateRemoteCode();
    mappings.push({
      code,
      url: normalizedUrl,
      createdAt: new Date().toISOString(),
      permanent,
    });
    writeRemoteMappings(mappings);
    return { success: true, code, reused: false, store: "file" };
  }

  const collection = db.collection(FIREBASE_COLLECTION);
  const duplicateSnapshot = await collection
    .where("normalizedUrl", "==", normalizedUrl)
    .limit(5)
    .get();

  let reusableEntry = null;
  const expiredDocs = [];

  duplicateSnapshot.forEach((doc) => {
    const data = doc.data();
    if (isEntryExpired(data)) {
      expiredDocs.push(doc.ref.delete());
      return;
    }

    if (!reusableEntry && Boolean(data.permanent) === permanent) {
      reusableEntry = { code: doc.id, ...data };
    }
  });

  if (expiredDocs.length) {
    await Promise.all(expiredDocs);
  }

  if (reusableEntry) {
    return { success: true, code: reusableEntry.code, reused: true, store: "firestore" };
  }

  const code = await generateUniqueRemoteCode(async (candidate) => {
    const existingDoc = await collection.doc(candidate).get();
    return existingDoc.exists;
  }, permanent ? generatePermanentRemoteCode : generateRemoteCode);

  const createdAt = new Date().toISOString();
  await collection.doc(code).set({
    url: normalizedUrl,
    normalizedUrl,
    createdAt,
    permanent,
  });

  return { success: true, code, reused: false, store: "firestore" };
}

async function resolveRemoteLinkFromStore(code) {
  const db = getFirestoreDb();

  if (!db) {
    const entry = pruneExpiredMappings().find((item) => item.code === code);
    if (!entry) {
      return null;
    }

    return {
      code: entry.code,
      url: entry.url || "",
      ready: Boolean(entry.url),
      store: "file",
    };
  }

  const doc = await db.collection(FIREBASE_COLLECTION).doc(code).get();
  if (!doc.exists) {
    return null;
  }

  const data = doc.data() || {};
  if (isEntryExpired(data)) {
    await doc.ref.delete();
    return null;
  }

  return {
    code: doc.id,
    url: data.url || "",
    ready: Boolean(data.url),
    store: "firestore",
  };
}

async function deleteRemoteCode(code, url) {
  const normalizedUrl = normalizeRemoteUrl(url);
  const db = getFirestoreDb();

  if (!db) {
    const mappings = pruneExpiredMappings();
    const entry = mappings.find((item) => item.code === code);
    if (!entry) {
      return { deleted: false };
    }

    if (normalizeRemoteUrl(entry.url) !== normalizedUrl) {
      return { deleted: false };
    }

    writeRemoteMappings(mappings.filter((item) => item.code !== code));
    return { deleted: true, store: "file" };
  }

  const docRef = db.collection(FIREBASE_COLLECTION).doc(code);
  const doc = await docRef.get();
  if (!doc.exists) {
    return { deleted: false };
  }

  const data = doc.data() || {};
  if (normalizeRemoteUrl(data.url) !== normalizedUrl) {
    return { deleted: false };
  }

  await docRef.delete();
  return { deleted: true, store: "firestore" };
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk.toString("utf8");
    });

    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });

    req.on("error", reject);
  });
}

function getPreferredLanIp() {
  const networks = os.networkInterfaces();
  for (const addresses of Object.values(networks)) {
    for (const address of addresses || []) {
      if (
        address.family === "IPv4" &&
        !address.internal &&
        (
          address.address.startsWith("192.168.") ||
          address.address.startsWith("10.") ||
          address.address.startsWith("172.")
        )
      ) {
        return address.address;
      }
    }
  }

  return null;
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function proxyDriveImage(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  const fileId = requestUrl.searchParams.get("id");
  const requestedMode = requestUrl.searchParams.get("mode");
  const mode =
    requestedMode === "thumb" || requestedMode === "screen" ? requestedMode : "full";
  const rangeHeader = req.headers.range;

  if (!API_KEY) {
    sendJson(res, 500, {
      error:
        "Missing GOOGLE_DRIVE_API_KEY environment variable. Add it before starting the server.",
    });
    return;
  }

  if (!fileId) {
    sendJson(res, 400, { error: "Missing image file id." });
    return;
  }

  try {
    const candidates =
      mode === "thumb"
        ? [
            `https://drive.google.com/thumbnail?id=${encodeURIComponent(fileId)}&sz=w480`,
            `https://lh3.googleusercontent.com/d/${encodeURIComponent(fileId)}=w480`,
            `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${encodeURIComponent(API_KEY)}`,
          ]
        : mode === "screen"
          ? [
              `https://drive.google.com/thumbnail?id=${encodeURIComponent(fileId)}&sz=w1920`,
              `https://lh3.googleusercontent.com/d/${encodeURIComponent(fileId)}=w1920`,
              `https://drive.google.com/thumbnail?id=${encodeURIComponent(fileId)}&sz=w1600`,
              `https://lh3.googleusercontent.com/d/${encodeURIComponent(fileId)}=w1600`,
              `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${encodeURIComponent(API_KEY)}`,
            ]
        : [
            `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${encodeURIComponent(API_KEY)}`,
            `https://drive.google.com/thumbnail?id=${encodeURIComponent(fileId)}&sz=w1600`,
            `https://lh3.googleusercontent.com/d/${encodeURIComponent(fileId)}=w1600`,
            `https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}`,
          ];

    let lastError = "Unable to fetch media from Google Drive.";

    for (const candidate of candidates) {
      const headers = {};
      if (rangeHeader) {
        headers.Range = rangeHeader;
      }

      const response = await fetch(candidate, {
        redirect: "follow",
        headers,
      });
      const contentType = response.headers.get("content-type") || "";

      if (!response.ok) {
        lastError = `Media request failed (${response.status}) for ${candidate}`;
        continue;
      }

      if (!response.body || (!contentType.startsWith("image/") && !contentType.startsWith("video/"))) {
        lastError = `Non-media response returned for ${candidate}`;
        continue;
      }

      const responseHeaders = {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=3600",
      };

      for (const [source, target] of [
        ["accept-ranges", "Accept-Ranges"],
        ["content-length", "Content-Length"],
        ["content-range", "Content-Range"],
        ["content-disposition", "Content-Disposition"],
      ]) {
        const value = response.headers.get(source);
        if (value) {
          responseHeaders[target] = value;
        }
      }

      res.writeHead(response.status, responseHeaders);

      for await (const chunk of response.body) {
        res.write(chunk);
      }
      res.end();
      return;
    }

    sendJson(res, 502, { error: lastError });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
}

function sendFile(res, filePath) {
  fs.readFile(filePath, (error, content) => {
    if (error) {
      sendJson(res, 404, { error: "File not found." });
      return;
    }

    const extension = path.extname(filePath).toLowerCase();
    const contentType =
      {
        ".html": "text/html; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".js": "application/javascript; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".svg": "image/svg+xml",
      }[extension] || "application/octet-stream";

    res.writeHead(200, { "Content-Type": contentType });
    res.end(content);
  });
}

function sanitizePathname(pathname) {
  const resolvedPath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!resolvedPath.startsWith(PUBLIC_DIR)) {
    return null;
  }
  return resolvedPath;
}

function extractFolderId(input) {
  if (!input) {
    return null;
  }

  const trimmed = input.trim();

  if (/^[a-zA-Z0-9_-]{10,}$/.test(trimmed)) {
    return trimmed;
  }

  try {
    const parsedUrl = new URL(trimmed);

    const folderMatch = parsedUrl.pathname.match(/\/folders\/([a-zA-Z0-9_-]+)/);
    if (folderMatch) {
      return folderMatch[1];
    }

    const idParam = parsedUrl.searchParams.get("id");
    if (idParam) {
      return idParam;
    }
  } catch (error) {
    return null;
  }

  return null;
}

async function driveListFiles(parentId, pageToken) {
  const driveUrl = new URL("https://www.googleapis.com/drive/v3/files");
  driveUrl.searchParams.set("key", API_KEY);
  driveUrl.searchParams.set(
    "q",
    `'${parentId}' in parents and trashed = false`
  );
  driveUrl.searchParams.set(
    "fields",
    "nextPageToken, files(id, name, mimeType, webViewLink, thumbnailLink, imageMediaMetadata)"
  );
  driveUrl.searchParams.set("pageSize", "1000");
  driveUrl.searchParams.set("orderBy", "folder,name_natural");
  driveUrl.searchParams.set("supportsAllDrives", "true");
  driveUrl.searchParams.set("includeItemsFromAllDrives", "true");
  if (pageToken) {
    driveUrl.searchParams.set("pageToken", pageToken);
  }

  const response = await fetch(driveUrl);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Drive API request failed (${response.status}): ${text}`);
  }

  return response.json();
}

async function driveGetFile(fileId) {
  const driveUrl = new URL(`https://www.googleapis.com/drive/v3/files/${fileId}`);
  driveUrl.searchParams.set("key", API_KEY);
  driveUrl.searchParams.set("fields", "id,name,mimeType");
  driveUrl.searchParams.set("supportsAllDrives", "true");

  const response = await fetch(driveUrl);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Drive metadata request failed (${response.status}): ${text}`);
  }

  return response.json();
}

function formatDriveAccessError(error) {
  const message = String(error?.message || "");
  if (
    message.includes("Drive metadata request failed (404)") ||
    message.includes("Drive metadata request failed (403)") ||
    message.includes("File not found") ||
    message.includes("notFound") ||
    message.includes("insufficientFilePermissions") ||
    message.includes("The user does not have sufficient permissions")
  ) {
    return DRIVE_LINK_ACCESS_ERROR;
  }

  return message || "We couldn’t verify that Google Drive folder right now.";
}

function createImageUrl(fileId, mode = "full") {
  const url = new URL("/api/image", "http://localhost");
  url.searchParams.set("id", fileId);
  if (mode === "thumb" || mode === "screen") {
    url.searchParams.set("mode", "thumb");
    if (mode === "screen") {
      url.searchParams.set("mode", "screen");
    }
  }
  return `${url.pathname}${url.search}`;
}

function isSupportedMediaFile(file, includeVideos = false) {
  if (!file.mimeType) {
    return false;
  }

  if (file.mimeType.startsWith(IMAGE_MIME_PREFIX)) {
    return true;
  }

  return includeVideos && file.mimeType.startsWith(VIDEO_MIME_PREFIX);
}

async function readFolderTree(folderId, rootName = "Root Folder", includeVideos = false) {
  const queue = [{ id: folderId, node: null, path: "" }];
  const images = [];
  let root = null;

  while (queue.length > 0) {
    const current = queue.shift();
    const node = {
      id: current.id,
      name: current.node ? current.node.name : rootName,
      folders: [],
      images: [],
    };

    if (!root) {
      root = node;
    } else if (current.node) {
      current.node.target.folders.push(node);
    }

    let pageToken = undefined;
    do {
      const data = await driveListFiles(current.id, pageToken);
      const files = data.files || [];

      for (const file of files) {
        if (file.mimeType === FOLDER_MIME_TYPE) {
          queue.push({
            id: file.id,
            path: current.path ? `${current.path}/${file.name}` : file.name,
            node: {
              name: file.name,
              target: node,
            },
          });
          continue;
        }

        if (!isSupportedMediaFile(file, includeVideos)) {
          continue;
        }

        const image = {
          id: file.id,
          name: file.name,
          mimeType: file.mimeType,
          path: current.path || "",
          url: createImageUrl(file.id, "full"),
          slideshowUrl: file.mimeType.startsWith(VIDEO_MIME_PREFIX)
            ? createImageUrl(file.id, "full")
            : createImageUrl(file.id, "screen"),
          thumbnailUrl: createImageUrl(file.id, "thumb"),
          webViewLink: file.webViewLink || "",
        };

        node.images.push(image);
        images.push(image);
      }

      pageToken = data.nextPageToken;
    } while (pageToken);
  }

  return {
    folderId,
    tree: root,
    images,
  };
}

async function handleApiFolder(req, res) {
  if (!API_KEY) {
    sendJson(res, 500, {
      error:
        "Missing GOOGLE_DRIVE_API_KEY environment variable. Add it before starting the server.",
    });
    return;
  }

  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  const input = requestUrl.searchParams.get("url") || "";
  const includeVideos = requestUrl.searchParams.get("includeVideos") === "1";
  const folderId = extractFolderId(input);

  if (!folderId) {
    sendJson(res, 400, {
      error:
        "Could not extract a Google Drive folder ID from the provided input.",
    });
    return;
  }

  try {
    const folderMeta = await driveGetFile(folderId);
    if (folderMeta.mimeType !== FOLDER_MIME_TYPE) {
      sendJson(res, 400, { error: "The provided link does not point to a Google Drive folder." });
      return;
    }

    const result = await readFolderTree(folderId, folderMeta.name || "Root Folder", includeVideos);
    sendJson(res, 200, result);
  } catch (error) {
    sendJson(res, 500, {
      error: formatDriveAccessError(error),
    });
  }
}

async function handleApiFolderMeta(req, res) {
  if (!API_KEY) {
    sendJson(res, 500, {
      error:
        "Missing GOOGLE_DRIVE_API_KEY environment variable. Add it before starting the server.",
    });
    return;
  }

  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  const input = requestUrl.searchParams.get("url") || "";
  const folderId = extractFolderId(input);

  if (!folderId) {
    sendJson(res, 400, {
      error:
        "Could not extract a Google Drive folder ID from the provided input.",
    });
    return;
  }

  try {
    const folderMeta = await driveGetFile(folderId);
    if (folderMeta.mimeType !== FOLDER_MIME_TYPE) {
      sendJson(res, 400, { error: "The provided link does not point to a Google Drive folder." });
      return;
    }

    sendJson(res, 200, {
      id: folderMeta.id,
      name: folderMeta.name,
    });
  } catch (error) {
    sendJson(res, 500, {
      error: formatDriveAccessError(error),
    });
  }
}

async function handleSaveRemoteLink(req, res) {
  try {
    const body = await readRequestBody(req);
    const url = normalizeRemoteUrl(body.url);
    const permanent = body.permanent === true;

    if (!url) {
      sendJson(res, 400, { error: "A Google Drive URL is required." });
      return;
    }

    if (!API_KEY) {
      sendJson(res, 500, {
        error:
          "Missing GOOGLE_DRIVE_API_KEY environment variable. Add it before starting the server.",
      });
      return;
    }

    const folderId = extractFolderId(url);
    if (!folderId) {
      sendJson(res, 400, {
        error: "Please paste a valid Google Drive folder link.",
      });
      return;
    }

    let folderMeta;
    try {
      folderMeta = await driveGetFile(folderId);
      if (folderMeta.mimeType !== FOLDER_MIME_TYPE) {
        sendJson(res, 400, { error: "The provided link does not point to a Google Drive folder." });
        return;
      }
    } catch (error) {
      sendJson(res, 400, { error: formatDriveAccessError(error) });
      return;
    }

    const result = await writeRemoteLinkToStore(url, permanent);
    sendJson(res, 200, {
      ...result,
      folderName: folderMeta?.name || "Google Drive folder",
    });
  } catch (error) {
    sendJson(res, 400, { error: error.message || "Invalid request body." });
  }
}

async function handleResolveRemoteCode(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  const code = String(requestUrl.searchParams.get("code") || "").trim();

  if (!/^\d{6}$|^\d{9}$/.test(code)) {
    sendJson(res, 400, { error: "Code must be a 6 or 9 digit number." });
    return;
  }

  const entry = await resolveRemoteLinkFromStore(code);
  if (!entry) {
    sendJson(res, 404, { error: "Code not found or it has expired. Generate a new code." });
    return;
  }

  sendJson(res, 200, {
    code: entry.code,
    url: entry.url || "",
    ready: Boolean(entry.url),
  });
}

async function handleDeleteRemoteCode(req, res) {
  try {
    const body = await readRequestBody(req);
    const code = String(body.code || "").trim();
    const url = normalizeRemoteUrl(body.url);

    if (!/^\d{6}$|^\d{9}$/.test(code)) {
      sendJson(res, 400, { error: "Please enter the full code." });
      return;
    }

    if (!url) {
      sendJson(res, 400, { error: "Please paste the original Google Drive folder link." });
      return;
    }

    const result = await deleteRemoteCode(code, url);
    if (!result.deleted) {
      sendJson(res, 404, {
        error: "We couldn’t match that code with the Google Drive link provided.",
      });
      return;
    }

    sendJson(res, 200, {
      success: true,
      message: "Code deleted.",
    });
  } catch (error) {
    sendJson(res, 400, { error: error.message || "Invalid request body." });
  }
}

async function handlePairingOrigin(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  const hostHeader = req.headers.host || "";
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "")
    .split(",")[0]
    .trim()
    .replace(/:$/, "");
  const protocol = (forwardedProto || requestUrl.protocol.replace(/:$/, "") || "http");
  const hostName = hostHeader.split(":")[0];
  const port = hostHeader.includes(":") ? hostHeader.split(":")[1] : String(PORT);

  let origin = `${protocol}://${hostHeader}`;
  if (
    !hostName ||
    hostName === "localhost" ||
    hostName === "127.0.0.1" ||
    hostName === "0.0.0.0" ||
    hostName === "10.0.2.2"
  ) {
    const lanIp = getPreferredLanIp();
    if (lanIp) {
      origin = `${protocol}://${lanIp}:${port}`;
    }
  }

  sendJson(res, 200, { origin });
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);

  if (requestUrl.pathname === "/api/folder") {
    await handleApiFolder(req, res);
    return;
  }

  if (requestUrl.pathname === "/api/folder-meta") {
    await handleApiFolderMeta(req, res);
    return;
  }

  if (requestUrl.pathname === "/api/image") {
    await proxyDriveImage(req, res);
    return;
  }

  if (requestUrl.pathname === "/api/remote/link" && req.method === "POST") {
    await handleSaveRemoteLink(req, res);
    return;
  }

  if (requestUrl.pathname === "/api/remote/resolve") {
    await handleResolveRemoteCode(req, res);
    return;
  }

  if (requestUrl.pathname === "/api/remote/delete" && req.method === "POST") {
    await handleDeleteRemoteCode(req, res);
    return;
  }

  if (requestUrl.pathname === "/api/pairing-origin") {
    await handlePairingOrigin(req, res);
    return;
  }

  const pathname =
    requestUrl.pathname === "/"
      ? "/index.html"
      : requestUrl.pathname === "/direct"
        ? "/index.html"
        : requestUrl.pathname === "/folders"
          ? "/index.html"
          : requestUrl.pathname === "/gallery"
            ? "/index.html"
      : requestUrl.pathname === "/remote"
        ? "/remote.html"
        : requestUrl.pathname === "/remote-tv"
          ? "/remote-tv.html"
        : requestUrl.pathname;
  const filePath = sanitizePathname(pathname);
  if (!filePath) {
    sendJson(res, 400, { error: "Invalid path." });
    return;
  }

  sendFile(res, filePath);
});

server.listen(PORT, HOST, () => {
  console.log(`DriveDeck running at http://${HOST}:${PORT}`);
});
