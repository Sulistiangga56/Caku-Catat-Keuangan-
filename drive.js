// drive.js
const { google } = require('googleapis');
const streamifier = require('streamifier');
const fs = require('fs');

// === konfigurasi ===
// Ambil dari Google Cloud Console setelah aktifin Drive API
const CREDENTIALS_PATH = './credentials.json';
const TOKEN_PATH = './token.json';

// --- load credentials dan token ---
const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH));
const token = JSON.parse(fs.readFileSync(TOKEN_PATH));

const { client_secret, client_id, redirect_uris } = credentials.web;
const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
oAuth2Client.setCredentials(token);

const drive = google.drive({ version: 'v3', auth: oAuth2Client });

/**
 * Upload buffer ke Google Drive
 * @param {Buffer} buffer - isi file (video)
 * @param {String} filename - nama file di Drive
 * @param {String?} folderId - ID folder target (opsional)
 */
async function uploadToDrive(buffer, filename, folderId = null) {
    try {
        const fileMetadata = {
            name: filename,
            parents: folderId ? [folderId] : undefined,
        };

        const media = {
            mimeType: 'video/mp4',
            body: streamifier.createReadStream(buffer),
        };

        const res = await drive.files.create({
            resource: fileMetadata,
            media,
            fields: 'id, webViewLink, webContentLink',
        });

        // ubah permission biar bisa diakses publik
        await drive.permissions.create({
            fileId: res.data.id,
            requestBody: {
                role: 'reader',
                type: 'anyone',
            },
        });

        return res.data;
    } catch (err) {
        console.error('❌ Gagal upload ke Drive:', err);
        throw err;
    }
}

// Ambil daftar file dari folder tertentu
async function listDriveFiles(folderId) {
    const drive = google.drive({ version: 'v3', auth: oAuth2Client });
    const res = await drive.files.list({
        q: `'${folderId}' in parents and mimeType contains 'video/' and trashed=false`,
        fields: 'files(id, name, webViewLink, webContentLink)',
    });
    return res.data.files;
}

// Download file dari Drive
async function getDriveFile(fileId, destPath) {
    const drive = google.drive({ version: 'v3', auth: oAuth2Client });
    const dest = fs.createWriteStream(destPath);
    await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' })
        .then(res => {
            return new Promise((resolve, reject) => {
                res.data
                    .on('end', () => resolve(destPath))
                    .on('error', reject)
                    .pipe(dest);
            });
        });
    return destPath;
}

module.exports = { uploadToDrive, listDriveFiles, getDriveFile };

