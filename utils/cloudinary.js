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

module.exports = { uploadToCloudinary };
