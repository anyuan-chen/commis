import db from '../database.js';
import { v4 as uuidv4 } from 'uuid';

export const ShortsJobModel = {
  create(data) {
    const id = uuidv4();

    const stmt = db.prepare(`
      INSERT INTO shorts_jobs (id, video_path, status, progress, title, description, tags_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      data.videoPath,
      'pending',
      0,
      data.title || null,
      data.description || null,
      data.tags ? JSON.stringify(data.tags) : null
    );

    return this.getById(id);
  },

  getById(id) {
    const row = db.prepare('SELECT * FROM shorts_jobs WHERE id = ?').get(id);
    if (!row) return null;
    return this._parseRow(row);
  },

  _parseRow(row) {
    // Parse variants from JSON, falling back to legacy columns
    let variants = [];
    if (row.variants_json) {
      variants = JSON.parse(row.variants_json);
    } else {
      // Backwards compat: build variants from legacy columns
      if (row.output_path) {
        variants.push({
          type: 'narrated',
          outputPath: row.output_path,
          youtubeVideoId: row.youtube_video_id || null,
          youtubeUrl: row.youtube_url || null
        });
      }
      if (row.output_path_asmr) {
        variants.push({
          type: 'asmr',
          outputPath: row.output_path_asmr,
          youtubeVideoId: row.asmr_youtube_video_id || null,
          youtubeUrl: row.asmr_youtube_url || null
        });
      }
    }

    return {
      id: row.id,
      videoPath: row.video_path,
      status: row.status,
      progress: row.progress,
      progressStage: row.progress_stage,
      errorMessage: row.error_message,
      clipStart: row.clip_start,
      clipEnd: row.clip_end,
      clipPath: row.clip_path,
      script: row.script,
      voiceoverPath: row.voiceover_path,
      outputPath: row.output_path,
      outputPathAsmr: row.output_path_asmr,
      thumbnailPath: row.thumbnail_path,
      title: row.title,
      description: row.description,
      tags: row.tags_json ? JSON.parse(row.tags_json) : [],
      youtubeVideoId: row.youtube_video_id,
      youtubeUrl: row.youtube_url,
      asmrYoutubeVideoId: row.asmr_youtube_video_id,
      asmrYoutubeUrl: row.asmr_youtube_url,
      variants,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  },

  updateStatus(id, status, progress = null, progressStage = null) {
    const fields = ['status = ?', 'updated_at = CURRENT_TIMESTAMP'];
    const values = [status];

    if (progress !== null) {
      fields.push('progress = ?');
      values.push(progress);
    }

    if (progressStage !== null) {
      fields.push('progress_stage = ?');
      values.push(progressStage);
    }

    values.push(id);
    db.prepare(`UPDATE shorts_jobs SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    return this.getById(id);
  },

  updateProgress(id, progress, progressStage = null) {
    const fields = ['progress = ?', 'updated_at = CURRENT_TIMESTAMP'];
    const values = [progress];

    if (progressStage) {
      fields.push('progress_stage = ?');
      values.push(progressStage);
    }

    values.push(id);
    db.prepare(`UPDATE shorts_jobs SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    return this.getById(id);
  },

  setClipInfo(id, clipStart, clipEnd, clipPath) {
    db.prepare(`
      UPDATE shorts_jobs
      SET clip_start = ?, clip_end = ?, clip_path = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(clipStart, clipEnd, clipPath, id);
    return this.getById(id);
  },

  setScript(id, script) {
    db.prepare('UPDATE shorts_jobs SET script = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(script, id);
    return this.getById(id);
  },

  setVoiceoverPath(id, voiceoverPath) {
    db.prepare('UPDATE shorts_jobs SET voiceover_path = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(voiceoverPath, id);
    return this.getById(id);
  },

  setOutputPath(id, outputPath, thumbnailPath = null) {
    const fields = ['output_path = ?', 'updated_at = CURRENT_TIMESTAMP'];
    const values = [outputPath];

    if (thumbnailPath) {
      fields.push('thumbnail_path = ?');
      values.push(thumbnailPath);
    }

    values.push(id);
    db.prepare(`UPDATE shorts_jobs SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    return this.getById(id);
  },

  setAsmrPath(id, asmrPath) {
    db.prepare('UPDATE shorts_jobs SET output_path_asmr = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(asmrPath, id);
    return this.getById(id);
  },

  setMetadata(id, { title, description, tags }) {
    const fields = ['updated_at = CURRENT_TIMESTAMP'];
    const values = [];

    if (title !== undefined) {
      fields.push('title = ?');
      values.push(title);
    }
    if (description !== undefined) {
      fields.push('description = ?');
      values.push(description);
    }
    if (tags !== undefined) {
      fields.push('tags_json = ?');
      values.push(JSON.stringify(tags));
    }

    values.push(id);
    db.prepare(`UPDATE shorts_jobs SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    return this.getById(id);
  },

  setYouTubeInfo(id, youtubeVideoId, youtubeUrl) {
    db.prepare(`
      UPDATE shorts_jobs
      SET youtube_video_id = ?, youtube_url = ?, status = 'uploaded', updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(youtubeVideoId, youtubeUrl, id);
    return this.getById(id);
  },

  setAsmrYouTubeInfo(id, youtubeVideoId, youtubeUrl) {
    db.prepare(`
      UPDATE shorts_jobs
      SET asmr_youtube_video_id = ?, asmr_youtube_url = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(youtubeVideoId, youtubeUrl, id);
    return this.getById(id);
  },

  /**
   * Add or update a variant in variants_json.
   * variant: { type: 'narrated'|'asmr'|..., outputPath, youtubeVideoId?, youtubeUrl? }
   */
  addVariant(id, variant) {
    const job = this.getById(id);
    if (!job) return null;
    const variants = job.variants.filter(v => v.type !== variant.type);
    variants.push(variant);
    db.prepare('UPDATE shorts_jobs SET variants_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(JSON.stringify(variants), id);
    // Also sync legacy columns for backwards compat
    if (variant.type === 'narrated' && variant.outputPath) {
      db.prepare('UPDATE shorts_jobs SET output_path = ? WHERE id = ?').run(variant.outputPath, id);
    }
    if (variant.type === 'asmr' && variant.outputPath) {
      db.prepare('UPDATE shorts_jobs SET output_path_asmr = ? WHERE id = ?').run(variant.outputPath, id);
    }
    return this.getById(id);
  },

  /**
   * Set YouTube info for a specific variant type
   */
  setVariantYouTube(id, type, youtubeVideoId, youtubeUrl) {
    const job = this.getById(id);
    if (!job) return null;
    const variants = job.variants.map(v =>
      v.type === type ? { ...v, youtubeVideoId, youtubeUrl } : v
    );
    db.prepare('UPDATE shorts_jobs SET variants_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(JSON.stringify(variants), id);
    // Sync legacy columns
    if (type === 'narrated') {
      db.prepare('UPDATE shorts_jobs SET youtube_video_id = ?, youtube_url = ?, status = \'uploaded\' WHERE id = ?')
        .run(youtubeVideoId, youtubeUrl, id);
    }
    if (type === 'asmr') {
      db.prepare('UPDATE shorts_jobs SET asmr_youtube_video_id = ?, asmr_youtube_url = ? WHERE id = ?')
        .run(youtubeVideoId, youtubeUrl, id);
    }
    return this.getById(id);
  },

  setError(id, errorMessage) {
    db.prepare('UPDATE shorts_jobs SET status = ?, error_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run('failed', errorMessage, id);
    return this.getById(id);
  },

  complete(id) {
    db.prepare('UPDATE shorts_jobs SET status = ?, progress = 100, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run('ready', id);
    return this.getById(id);
  },

  getRecent(limit = 10) {
    return db.prepare(
      'SELECT * FROM shorts_jobs ORDER BY created_at DESC LIMIT ?'
    ).all(limit).map(row => this._parseRow(row));
  },

  getByStatus(status) {
    return db.prepare(
      'SELECT * FROM shorts_jobs WHERE status = ? ORDER BY created_at DESC'
    ).all(status).map(row => this._parseRow(row));
  }
};
