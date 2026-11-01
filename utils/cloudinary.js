const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

function uploadStream(fileBuffer, options) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(options, (error, result) => {
      if (error) return reject(error);
      return resolve(result);
    });

    stream.end(fileBuffer);
  });
}

async function uploadToCloudinary(fileBuffer, mimeType, folder) {
  if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
    throw new Error('Cloudinary storage not configured');
  }

  const result = await uploadStream(fileBuffer, {
    folder,
    resource_type: mimeType && mimeType.startsWith('image/') ? 'image' : 'auto',
  });

  if (!result.secure_url) {
    throw new Error('Cloudinary upload did not return a secure URL');
  }

  return result.secure_url;
}

async function uploadReviewMedia(fileBuffer, mediaType, userId) {
  if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
    throw new Error('Cloudinary storage not configured');
  }

  const resourceType = mediaType === 'image' ? 'image' : 'video';
  const result = await uploadStream(fileBuffer, {
    folder: `review-media/${userId}`,
    resource_type: resourceType,
    use_filename: false,
    unique_filename: true,
    overwrite: false,
  });

  if (!result.secure_url || !result.public_id) {
    throw new Error('Cloudinary upload did not return the required media metadata');
  }

  return {
    url: result.secure_url,
    publicId: result.public_id,
    resourceType,
  };
}

async function deleteReviewMedia(asset) {
  if (!asset?.publicId || !['image', 'video'].includes(asset.resourceType)) {
    throw new Error('A valid uploaded review media asset is required for cleanup');
  }

  const result = await cloudinary.uploader.destroy(asset.publicId, {
    resource_type: asset.resourceType,
    invalidate: true,
  });
  if (!['ok', 'not found'].includes(result.result)) {
    throw new Error(`Cloudinary cleanup failed with result: ${result.result || 'unknown'}`);
  }
}

module.exports = { uploadToCloudinary, uploadReviewMedia, deleteReviewMedia };
