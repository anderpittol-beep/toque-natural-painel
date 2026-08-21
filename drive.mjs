// Baixa o .xlsx da planilha direto do Google Drive usando uma conta de serviço.
// Requer: a planilha compartilhada (leitor) com o e-mail da service account.
import { google } from 'googleapis';

export async function baixarPlanilha(fileId, credentialsJson) {
  const creds = typeof credentialsJson === 'string'
    ? JSON.parse(credentialsJson)
    : credentialsJson;

  const auth = new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  });
  await auth.authorize();

  const drive = google.drive({ version: 'v3', auth });
  const res = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'arraybuffer' }
  );
  return Buffer.from(res.data);
}
