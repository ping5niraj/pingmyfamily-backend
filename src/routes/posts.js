/**
 * posts.js — Social Feed API
 * C:\Projects\PingMyFamily\backend\src\routes\posts.js
 *
 * Endpoints:
 *   POST   /api/posts                          — create post with media
 *   GET    /api/posts/feed                     — get family feed (paginated)
 *   DELETE /api/posts/:id                      — delete own post
 *   POST   /api/posts/:id/like                 — toggle like (like/unlike)
 *   GET    /api/posts/:id/comments             — get comments for a post
 *   POST   /api/posts/:id/comments             — add a comment
 *   DELETE /api/posts/:id/comments/:comment_id — delete own comment
 *   GET    /api/posts/stats/:user_id           — family stats for dashboard
 */

const express = require('express');
const router  = express.Router();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const authMiddleware = require('../middleware/auth');

router.use(authMiddleware);

// ─────────────────────────────────────────
// Helper — get all verified family member IDs for a user
// Reuses the same relationship table — no new traversal needed
// Returns Set of user IDs (including the user themselves)
// ─────────────────────────────────────────
async function getFamilyMemberIds(userId) {
  const ids = new Set([userId]);

  // Outgoing verified relationships
  const { data: outgoing } = await supabase
    .from('pmf_relationships')
    .select('to_user_id')
    .eq('from_user_id', userId)
    .eq('verification_status', 'verified')
    .eq('is_offline', false);

  // Incoming verified relationships
  const { data: incoming } = await supabase
    .from('pmf_relationships')
    .select('from_user_id')
    .eq('to_user_id', userId)
    .eq('verification_status', 'verified')
    .eq('is_offline', false);

  (outgoing || []).forEach(r => { if (r.to_user_id) ids.add(r.to_user_id); });
  (incoming || []).forEach(r => { if (r.from_user_id) ids.add(r.from_user_id); });

  return ids;
}

// ─────────────────────────────────────────
// POST /api/posts
// Create a new post with optional media
// Body: { caption, visibility, media: [{ media_url, media_type, thumbnail_url, duration_seconds }] }
// ─────────────────────────────────────────
router.post('/', async (req, res) => {
  const { caption, visibility = 'family', media = [] } = req.body;

  if (!caption && media.length === 0) {
    return res.status(400).json({ error: 'Post must have a caption or at least one image/video' });
  }

  // Validate video duration
  for (const m of media) {
    if (m.media_type === 'video' && m.duration_seconds > 30) {
      return res.status(400).json({ error: 'Video duration must be 30 seconds or less' });
    }
  }

  try {
    // Create the post
    const { data: post, error: postError } = await supabase
      .from('pmf_posts')
      .insert({ user_id: req.user.id, caption, visibility })
      .select()
      .single();

    if (postError) throw postError;

    // Insert media records if any
    if (media.length > 0) {
      const mediaRows = media.map((m, i) => ({
        post_id:          post.id,
        media_url:        m.media_url,
        media_type:       m.media_type,
        thumbnail_url:    m.thumbnail_url || null,
        duration_seconds: m.duration_seconds || null,
        order_index:      i,
      }));

      const { error: mediaError } = await supabase
        .from('pmf_post_media')
        .insert(mediaRows);

      if (mediaError) throw mediaError;
    }

    return res.json({ success: true, post_id: post.id, message: 'பதிவு வெளியிடப்பட்டது / Post published' });

  } catch (err) {
    console.error('Create post error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
// GET /api/posts/feed
// Get paginated family feed
// Query: ?page=1&limit=20
// Returns posts from all verified family members
// Each post includes: user info, media, like count, comment count, did_i_like
// ─────────────────────────────────────────
router.get('/feed', async (req, res) => {
  const page  = parseInt(req.query.page)  || 1;
  const limit = parseInt(req.query.limit) || 20;
  const offset = (page - 1) * limit;

  try {
    // Get all family member IDs
    const familyIds = await getFamilyMemberIds(req.user.id);
    const familyIdsArray = Array.from(familyIds);

    if (familyIdsArray.length === 0) {
      return res.json({ success: true, posts: [], has_more: false, page });
    }

    // Fetch posts from family members — newest first
    const { data: posts, error: postsError } = await supabase
      .from('pmf_posts')
      .select(`
        id, caption, visibility, created_at,
        user:user_id(id, name, kutham, profile_photo)
      `)
      .in('user_id', familyIdsArray)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (postsError) throw postsError;

    if (!posts || posts.length === 0) {
      return res.json({ success: true, posts: [], has_more: false, page });
    }

    const postIds = posts.map(p => p.id);

    // Fetch media for all posts in one query
    const { data: allMedia } = await supabase
      .from('pmf_post_media')
      .select('*')
      .in('post_id', postIds)
      .order('order_index', { ascending: true });

    // Fetch like counts for all posts in one query
    const { data: allLikes } = await supabase
      .from('pmf_likes')
      .select('post_id, user_id')
      .in('post_id', postIds);

    // Fetch comment counts for all posts in one query
    const { data: allComments } = await supabase
      .from('pmf_comments')
      .select('post_id')
      .in('post_id', postIds);

    // Build lookup maps
    const mediaByPost   = {};
    const likesByPost   = {};
    const commentsByPost = {};

    (allMedia    || []).forEach(m => {
      if (!mediaByPost[m.post_id]) mediaByPost[m.post_id] = [];
      mediaByPost[m.post_id].push(m);
    });
    (allLikes    || []).forEach(l => {
      if (!likesByPost[l.post_id]) likesByPost[l.post_id] = [];
      likesByPost[l.post_id].push(l.user_id);
    });
    (allComments || []).forEach(c => {
      if (!commentsByPost[c.post_id]) commentsByPost[c.post_id] = 0;
      commentsByPost[c.post_id]++;
    });

    // Assemble final response
    const enrichedPosts = posts.map(post => ({
      ...post,
      media:         mediaByPost[post.id]   || [],
      like_count:    (likesByPost[post.id]   || []).length,
      comment_count: commentsByPost[post.id] || 0,
      did_i_like:    (likesByPost[post.id]   || []).includes(req.user.id),
    }));

    return res.json({
      success:  true,
      posts:    enrichedPosts,
      has_more: posts.length === limit,
      page,
    });

  } catch (err) {
    console.error('Feed error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
// DELETE /api/posts/:id
// Delete own post (cascades media, likes, comments via DB)
// ─────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const { data: post } = await supabase
      .from('pmf_posts')
      .select('id, user_id')
      .eq('id', req.params.id)
      .single();

    if (!post) return res.status(404).json({ error: 'Post not found' });
    if (post.user_id !== req.user.id) return res.status(403).json({ error: 'You can only delete your own posts' });

    await supabase.from('pmf_posts').delete().eq('id', req.params.id);

    return res.json({ success: true, message: 'பதிவு நீக்கப்பட்டது / Post deleted' });
  } catch (err) {
    console.error('Delete post error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
// POST /api/posts/:id/like
// Toggle like — if already liked, unlike. If not, like.
// ─────────────────────────────────────────
router.post('/:id/like', async (req, res) => {
  const postId = req.params.id;
  const userId = req.user.id;

  try {
    // Check if already liked
    const { data: existing } = await supabase
      .from('pmf_likes')
      .select('id')
      .eq('post_id', postId)
      .eq('user_id', userId)
      .single();

    if (existing) {
      // Already liked — remove like
      await supabase.from('pmf_likes').delete().eq('id', existing.id);
      const { count } = await supabase.from('pmf_likes').select('id', { count: 'exact' }).eq('post_id', postId);
      return res.json({ success: true, liked: false, like_count: count || 0 });
    } else {
      // Not liked — add like
      await supabase.from('pmf_likes').insert({ post_id: postId, user_id: userId });
      const { count } = await supabase.from('pmf_likes').select('id', { count: 'exact' }).eq('post_id', postId);
      return res.json({ success: true, liked: true, like_count: count || 0 });
    }
  } catch (err) {
    console.error('Like error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
// GET /api/posts/:id/comments
// Get all comments for a post
// Includes commenter name and profile photo
// ─────────────────────────────────────────
router.get('/:id/comments', async (req, res) => {
  try {
    const { data: comments, error } = await supabase
      .from('pmf_comments')
      .select(`
        id, content, created_at,
        user:user_id(id, name, profile_photo)
      `)
      .eq('post_id', req.params.id)
      .order('created_at', { ascending: true });

    if (error) throw error;

    return res.json({ success: true, comments: comments || [] });
  } catch (err) {
    console.error('Get comments error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
// POST /api/posts/:id/comments
// Add a comment to a post
// Body: { content }
// ─────────────────────────────────────────
router.post('/:id/comments', async (req, res) => {
  const { content } = req.body;
  if (!content || content.trim().length === 0) {
    return res.status(400).json({ error: 'Comment cannot be empty' });
  }

  try {
    const { data: comment, error } = await supabase
      .from('pmf_comments')
      .insert({ post_id: req.params.id, user_id: req.user.id, content: content.trim() })
      .select(`id, content, created_at, user:user_id(id, name, profile_photo)`)
      .single();

    if (error) throw error;

    return res.json({ success: true, comment });
  } catch (err) {
    console.error('Add comment error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
// DELETE /api/posts/:id/comments/:comment_id
// Delete own comment
// ─────────────────────────────────────────
router.delete('/:id/comments/:comment_id', async (req, res) => {
  try {
    const { data: comment } = await supabase
      .from('pmf_comments')
      .select('id, user_id')
      .eq('id', req.params.comment_id)
      .eq('post_id', req.params.id)
      .single();

    if (!comment) return res.status(404).json({ error: 'Comment not found' });
    if (comment.user_id !== req.user.id) return res.status(403).json({ error: 'You can only delete your own comments' });

    await supabase.from('pmf_comments').delete().eq('id', req.params.comment_id);

    return res.json({ success: true, message: 'கருத்து நீக்கப்பட்டது / Comment deleted' });
  } catch (err) {
    console.error('Delete comment error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
// GET /api/posts/stats/:user_id
// Family stats for Dashboard home screen
// Returns: total_relatives, generations, kutham_count, upcoming_birthdays, total_posts
// ─────────────────────────────────────────
router.get('/stats/:user_id', async (req, res) => {
  const userId = req.params.user_id;

  try {
    const familyIds = await getFamilyMemberIds(userId);
    const familyIdsArray = Array.from(familyIds);

    // Total relatives (excluding self)
    const total_relatives = familyIdsArray.length - 1;

    // Fetch all family member profiles
    const { data: members } = await supabase
      .from('pmf_users')
      .select('id, kutham, date_of_birth')
      .in('id', familyIdsArray);

    // Kutham count — how many distinct kuthams in the family
    const kuthams = new Set((members || []).map(m => m.kutham).filter(Boolean));
    const kutham_count = kuthams.size;

    // Upcoming birthdays in next 30 days
    const today = new Date();
    const in30  = new Date(today); in30.setDate(today.getDate() + 30);
    const upcoming_birthdays = (members || []).filter(m => {
      if (!m.date_of_birth) return false;
      const dob = new Date(m.date_of_birth);
      // Compare month and day only (ignore year)
      const thisYear = new Date(today.getFullYear(), dob.getMonth(), dob.getDate());
      return thisYear >= today && thisYear <= in30;
    }).length;

    // Total posts from family
    const { count: total_posts } = await supabase
      .from('pmf_posts')
      .select('id', { count: 'exact' })
      .in('user_id', familyIdsArray);

    // Offline/deceased members count
    const { count: total_offline } = await supabase
      .from('pmf_relationships')
      .select('id', { count: 'exact' })
      .eq('from_user_id', userId)
      .eq('is_offline', true);

    return res.json({
      success: true,
      stats: {
        total_relatives,
        kutham_count,
        upcoming_birthdays,
        total_posts:   total_posts   || 0,
        total_offline: total_offline || 0,
      },
    });

  } catch (err) {
    console.error('Stats error:', err);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
