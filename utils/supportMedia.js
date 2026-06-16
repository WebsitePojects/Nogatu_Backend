/**
 * Shared media-upload helpers for support ticket attachments.
 * One image or video per message. Mirrors the news.js upload pattern but with
 * its own size caps and Cloudinary folder.
 */
const multer = require('multer');
const { cloudinary } = require('./cloudinary');

const IMAGE_MAX_BYTES = 5 * 1024 * 1024;   // 5 MB
const VIDEO_MAX_BYTES = 50 * 1024 * 1024;  // 50 MB

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: VIDEO_MAX_BYTES },
  fileFilter: (_req, file, cb) => {
    const ok = file.mimetype?.startsWith('image/') || file.mimetype?.startsWith('video/');
    if (!ok) return cb(new Error('Only image or video files are allowed'));
    cb(null, true);
  },
});

// Accepts both multipart (with optional `media` file) and JSON requests.
function handleSupportUpload(req, res, next) {
  upload.single('media')(req, res, (err) => {
    if (!err) {
      if (req.file && req.file.mimetype?.startsWith('image/') && req.file.size > IMAGE_MAX_BYTES) {
        return res.status(400).json({ error: 'Image exceeds the 5 MB limit.' });
      }
      return next();
    }
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'Video exceeds the 50 MB limit.' });
      }
      return res.status(400).json({ error: err.message || 'Invalid upload.' });
    }
    if (String(err.message || '').includes('Only image or video')) {
      return res.status(400).json({ error: err.message });
    }
    return res.status(400).json({ error: 'Invalid upload payload.' });
  });
}

async function uploadSupportMedia(file) {
  if (!file) return null;
  if (!cloudinary) {
    const error = new Error('Media upload is not configured on the server.');
    error.code = 'UPLOAD_NOT_CONFIGURED';
    throw error;
  }
  const isVideo = file.mimetype?.startsWith('video/');
  const secureUrl = await new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: 'nogatu/support', resource_type: isVideo ? 'video' : 'image' },
      (err, result) => (err ? reject(err) : resolve(result?.secure_url || null))
    );
    stream.end(file.buffer);
  });
  return secureUrl ? { url: secureUrl, type: isVideo ? 'video' : 'image' } : null;
}

const MAX_IMAGES = 5;
const MAX_VIDEOS = 1;

/**
 * Create a Cloudinary signed-upload payload so the BROWSER can upload directly
 * to Cloudinary (server never touches the bytes). Returns null if unconfigured.
 */
function createUploadSignature(folder = 'nogatu/support') {
  if (!cloudinary) return null;
  const timestamp = Math.round(Date.now() / 1000);
  const paramsToSign = { folder, timestamp };
  const signature = cloudinary.utils.api_sign_request(paramsToSign, process.env.CLOUDINARY_API_SECRET);
  return {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME,
    apiKey: process.env.CLOUDINARY_API_KEY,
    timestamp,
    signature,
    folder,
    uploadUrl: `https://api.cloudinary.com/v1_1/${process.env.CLOUDINARY_CLOUD_NAME}/auto/upload`,
  };
}

/**
 * Delete a Cloudinary asset by public_id — used when a user discards a staged
 * upload before sending. Guarded to the support folder so a member can't delete
 * arbitrary assets. Best-effort; never throws to the caller.
 */
async function deleteSupportUpload(publicId, resourceType = 'image') {
  if (!cloudinary || !publicId) return false;
  if (!String(publicId).startsWith('nogatu/support')) return false; // folder guard
  try {
    await cloudinary.uploader.destroy(String(publicId), {
      resource_type: resourceType === 'video' ? 'video' : 'image',
    });
    return true;
  } catch {
    return false; // orphan-sweep worker will catch it later
  }
}

/**
 * Validate a client-reported attachments array (from direct uploads).
 * Enforces <=5 images + <=1 video and that every URL is an https Cloudinary URL.
 * Returns { ok, attachments, error }.
 */
function validateAttachments(raw) {
  if (raw == null) return { ok: true, attachments: [] };
  let list = raw;
  if (typeof raw === 'string') {
    try { list = JSON.parse(raw); } catch { return { ok: false, error: 'Malformed attachments.' }; }
  }
  if (!Array.isArray(list)) return { ok: false, error: 'Attachments must be a list.' };
  if (list.length === 0) return { ok: true, attachments: [] };

  let images = 0;
  let videos = 0;
  const clean = [];
  for (const a of list) {
    const type = a?.type === 'video' ? 'video' : 'image';
    const url = String(a?.url || '');
    if (!/^https:\/\/res\.cloudinary\.com\//.test(url)) {
      return { ok: false, error: 'Invalid attachment URL.' };
    }
    if (type === 'video') videos += 1; else images += 1;
    clean.push({
      type,
      url,
      publicId: a?.publicId ? String(a.publicId).slice(0, 255) : null,
      width: Number.isFinite(a?.width) ? Number(a.width) : null,
      height: Number.isFinite(a?.height) ? Number(a.height) : null,
      bytes: Number.isFinite(a?.bytes) ? Number(a.bytes) : null,
    });
  }
  if (images > MAX_IMAGES) return { ok: false, error: `Up to ${MAX_IMAGES} images per message.` };
  if (videos > MAX_VIDEOS) return { ok: false, error: `Up to ${MAX_VIDEOS} video per message.` };
  return { ok: true, attachments: clean };
}

module.exports = {
  handleSupportUpload,
  uploadSupportMedia,
  createUploadSignature,
  validateAttachments,
  deleteSupportUpload,
  MAX_IMAGES,
  MAX_VIDEOS,
};
