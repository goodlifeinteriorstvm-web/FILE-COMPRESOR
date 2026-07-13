const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const { PDFDocument } = require('pdf-lib');
const fs = require('fs');
const path = require('path');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

const UPLOAD_DIR = path.join(db.DATA_DIR, 'uploads');
const COMPRESSED_DIR = path.join(db.DATA_DIR, 'compressed');
[UPLOAD_DIR, COMPRESSED_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR));
app.use('/compressed', express.static(COMPRESSED_DIR));

// ---- Multer setup ----
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, unique + path.extname(file.originalname));
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB
  fileFilter: (req, file, cb) => {
    const allowed = ['application/pdf', 'image/jpeg', 'image/png'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Unsupported file type. Only PDF, JPG, PNG allowed.'));
  }
});

function typeFromMime(mimetype) {
  if (mimetype === 'application/pdf') return 'pdf';
  if (mimetype === 'image/jpeg') return 'jpg';
  if (mimetype === 'image/png') return 'png';
  return 'unknown';
}

// ---- Upload endpoint ----
app.post('/api/upload', (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const fileType = typeFromMime(req.file.mimetype);
    let pages = null;

    if (fileType === 'pdf') {
      try {
        const bytes = fs.readFileSync(req.file.path);
        const pdfDoc = await PDFDocument.load(bytes, { updateMetadata: false });
        pages = pdfDoc.getPageCount();
      } catch (e) {
        pages = null;
      }
    }

    const stmt = db.prepare(`
      INSERT INTO files (original_name, file_type, original_path, original_size, pages, status)
      VALUES (?, ?, ?, ?, ?, 'uploaded')
    `);
    const info = stmt.run(req.file.originalname, fileType, req.file.filename, req.file.size, pages);

    res.json({
      id: info.lastInsertRowid,
      original_name: req.file.originalname,
      file_type: fileType,
      original_size: req.file.size,
      pages
    });
  });
});

// ---- Compress endpoint ----
app.post('/api/compress/:id', async (req, res) => {
  const id = req.params.id;
  const quality = Math.min(100, Math.max(1, parseInt(req.body.quality, 10) || 72));

  const row = db.prepare('SELECT * FROM files WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'File not found' });

  const inputPath = path.join(UPLOAD_DIR, row.original_path);
  if (!fs.existsSync(inputPath)) return res.status(404).json({ error: 'Original file missing on disk' });

  const outName = `compressed-${Date.now()}-${path.basename(row.original_path)}`;
  const outputPath = path.join(COMPRESSED_DIR, outName);

  db.prepare('UPDATE files SET status = ? WHERE id = ?').run('compressing', id);

  try {
    if (row.file_type === 'jpg') {
      await sharp(inputPath)
        .jpeg({ quality, mozjpeg: true })
        .toFile(outputPath);
    } else if (row.file_type === 'png') {
      // Map quality (1-100) to png compressionLevel (9-0) & palette quantization
      const compressionLevel = Math.round(9 - (quality / 100) * 9);
      await sharp(inputPath)
        .png({ quality, compressionLevel: Math.min(9, Math.max(0, compressionLevel)), palette: true })
        .toFile(outputPath);
    } else if (row.file_type === 'pdf') {
      const bytes = fs.readFileSync(inputPath);
      const pdfDoc = await PDFDocument.load(bytes, { updateMetadata: false });
      // Strip metadata to shave size, then save with object streams for compression
      pdfDoc.setTitle('');
      pdfDoc.setAuthor('');
      pdfDoc.setSubject('');
      pdfDoc.setKeywords([]);
      pdfDoc.setProducer('');
      pdfDoc.setCreator('');
      const savedBytes = await pdfDoc.save({ useObjectStreams: true });
      fs.writeFileSync(outputPath, savedBytes);
    } else {
      throw new Error('Unsupported file type for compression');
    }

    const compressedSize = fs.statSync(outputPath).size;
    // Safety: never report "compressed" file bigger than original for images at high quality
    const savedPercent = Math.max(0, ((row.original_size - compressedSize) / row.original_size) * 100);

    db.prepare(`
      UPDATE files SET compressed_path = ?, compressed_size = ?, quality = ?, saved_percent = ?, status = 'done'
      WHERE id = ?
    `).run(outName, compressedSize, quality, savedPercent, id);

    res.json({
      id: Number(id),
      compressed_size: compressedSize,
      saved_percent: Math.round(savedPercent * 10) / 10,
      download_url: `/compressed/${outName}`
    });
  } catch (e) {
    db.prepare('UPDATE files SET status = ? WHERE id = ?').run('error', id);
    res.status(500).json({ error: 'Compression failed: ' + e.message });
  }
});

// ---- History / stats endpoints ----
app.get('/api/history', (req, res) => {
  const { type = 'all', search = '', date = '' } = req.query;
  let query = 'SELECT * FROM files WHERE 1=1';
  const params = [];

  if (type !== 'all') {
    query += ' AND file_type = ?';
    params.push(type);
  }
  if (search) {
    query += ' AND original_name LIKE ?';
    params.push(`%${search}%`);
  }
  if (date) {
    query += ` AND date(uploaded_at) = ?`;
    params.push(date);
  }
  query += ' ORDER BY id DESC LIMIT 200';

  const rows = db.prepare(query).all(...params);
  res.json(rows);
});

app.get('/api/stats', (req, res) => {
  const totalFiles = db.prepare('SELECT COUNT(*) c FROM files WHERE status = ?').get('done').c;
  const storageSaved = db.prepare('SELECT COALESCE(SUM(original_size - compressed_size),0) s FROM files WHERE status = ?').get('done').s;
  const avgCompression = db.prepare('SELECT COALESCE(AVG(saved_percent),0) a FROM files WHERE status = ?').get('done').a;
  const todayFiles = db.prepare(`SELECT COUNT(*) c FROM files WHERE date(uploaded_at) = date('now', 'localtime')`).get().c;

  res.json({
    totalFiles,
    storageSaved,
    avgCompression: Math.round(avgCompression * 10) / 10,
    todayFiles
  });
});

app.delete('/api/file/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM files WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });

  [row.original_path && path.join(UPLOAD_DIR, row.original_path),
   row.compressed_path && path.join(COMPRESSED_DIR, row.compressed_path)]
    .filter(Boolean)
    .forEach(p => { try { fs.unlinkSync(p); } catch (_) {} });

  db.prepare('DELETE FROM files WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

app.listen(PORT, () => {
  console.log(`File Compressor server running on http://localhost:${PORT}`);
});
