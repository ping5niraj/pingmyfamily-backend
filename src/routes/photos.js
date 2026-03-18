const express = require('express');
const router = express.Router();
const multer = require('multer');
const { PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { v4: uuidv4 } = require('uuid');
const r2Client = require('../r2');
const supabase = require('../supabase');
const authMiddleware = require('../middleware/auth');

// ─── Multer setup — memory storage ────────────────────
// Max 5MB, images only
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  }
});

// ─────────────────────────────────────────
// POST /api/photos/upload
// Upload profile photo to Cloudflare R2
// Form data: { photo: file }
// ─────────────────────────────────────────
router.post('/upload', authMiddleware, upload.single('photo'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No photo provided' });
    }

    const ext = req.file.originalname.split('.').pop() || 'jpg';
    const fileName = `profiles/${req.user.id}/${uuidv4()}.${ext}`;

    // Upload to R2
    await r2Client.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: fileName,
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
    }));

    const photoUrl = `${process.env.R2_PUBLIC_URL}/${fileName}`;

    // Get old photo URL to delete it
    const { data: currentUser } = await supabase
      .from('pmf_users')
      .select('profile_photo')
      .eq('id', req.user.id)
      .single();

    // Delete old photo from R2 if exists
    if (currentUser?.profile_photo) {
      try {
        const oldKey = currentUser.profile_photo.replace(`${process.env.R2_PUBLIC_URL}/`, '');
        await r2Client.send(new DeleteObjectCommand({
          Bucket: process.env.R2_BUCKET_NAME,
          Key: oldKey,
        }));
      } catch (e) {
        console.log('Old photo delete failed (ok):', e.message);
      }
    }

    // Update user profile_photo in Supabase
    const { error: updateError } = await supabase
      .from('pmf_users')
      .update({ profile_photo: photoUrl })
      .eq('id', req.user.id);

    if (updateError) {
      return res.status(500).json({ error: 'Failed to update profile photo' });
    }

    return res.json({
      success: true,
      photo_url: photoUrl,
      message: 'Profile photo updated successfully'
    });

  } catch (err) {
    console.error('Photo upload error:', err);
    return res.status(500).json({ error: 'Photo upload failed: ' + err.message });
  }
});

// ─────────────────────────────────────────
// DELETE /api/photos/remove
// Remove profile photo
// ─────────────────────────────────────────
router.delete('/remove', authMiddleware, async (req, res) => {
  try {
    const { data: currentUser } = await supabase
      .from('pmf_users')
      .select('profile_photo')
      .eq('id', req.user.id)
      .single();

    if (currentUser?.profile_photo) {
      const oldKey = currentUser.profile_photo.replace(`${process.env.R2_PUBLIC_URL}/`, '');
      await r2Client.send(new DeleteObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: oldKey,
      }));
    }

    await supabase
      .from('pmf_users')
      .update({ profile_photo: null })
      .eq('id', req.user.id);

    return res.json({ success: true, message: 'Profile photo removed' });

  } catch (err) {
    console.error('Photo remove error:', err);
    return res.status(500).json({ error: 'Failed to remove photo' });
  }
});

module.exports = router;
