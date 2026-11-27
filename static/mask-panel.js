addEventListener(window.VISOR_STATIC.readyEvent, () => {
  const viewer = window.VISOR_STATIC;
  const download = document.getElementById('exp');
  if (!viewer?.captureMaskPair || !download) return;
  const savedMask = document.getElementById('htCargar');
  if (savedMask) savedMask.hidden = true;

  if (viewer.importPublishedLabel) {
    const load = document.createElement('button');
    load.type = 'button';
    load.textContent = 'Load published label';
    load.onclick = async () => {
      load.disabled = true;
      try {
        await viewer.importPublishedLabel();
      } catch (error) {
        msg(error.message);
      } finally {
        load.disabled = false;
      }
    };
    download.before(load);
  }

  const upload = document.createElement('button');
  upload.type = 'button';
  upload.textContent = 'Upload masks';
  download.after(upload);

  const dialog = document.createElement('dialog');
  dialog.className = 'staticMaskUpload';
  dialog.setAttribute('aria-labelledby', 'maskUploadTitle');
  dialog.innerHTML = `
    <form autocomplete="off">
      <h2 id="maskUploadTitle">Upload masks</h2>
      <p class="maskUploadFiles"></p>
      <label>Destination
        <select name="destination">
          <option value="hf">Hugging Face</option>
          <option value="s3">Amazon S3</option>
        </select>
      </label>
      <fieldset data-destination="hf">
        <legend>Hugging Face dataset</legend>
        <label>Dataset <input name="dataset" placeholder="owner/dataset" required></label>
        <label>Write token <input name="token" type="password" required></label>
      </fieldset>
      <fieldset data-destination="s3" hidden disabled>
        <legend>Presigned HTTPS PUT URLs</legend>
        <label>Ink mask <input name="inkUrl" type="password" required></label>
        <label>Supervision mask <input name="supervisionUrl" type="password" required></label>
      </fieldset>
      <p role="status" class="maskUploadStatus"></p>
      <div class="maskUploadActions">
        <button type="button">Close</button>
        <button type="submit">Upload pair</button>
      </div>
    </form>`;
  document.body.append(dialog);

  const form = dialog.querySelector('form'), fields = form.elements;
  const groups = [...form.querySelectorAll('fieldset')];
  const status = dialog.querySelector('.maskUploadStatus');
  const close = dialog.querySelector('button[type=button]');
  const submit = dialog.querySelector('button[type=submit]');
  let snapshot, sending = false, uploaded = false;
  const sentToS3 = new Map();

  function updateFields() {
    fields.destination.disabled = sending || uploaded;
    for (const group of groups) {
      group.hidden = group.dataset.destination !== fields.destination.value;
      group.disabled = group.hidden || sending || uploaded;
    }
    submit.disabled = sending || uploaded;
    close.disabled = sending;
  }
  fields.destination.onchange = () => { status.textContent = ''; updateFields(); };
  close.onclick = () => dialog.close();
  dialog.oncancel = event => { if (sending) event.preventDefault(); };
  dialog.onclose = () => {
    snapshot = null;
    fields.token.value = fields.inkUrl.value = fields.supervisionUrl.value = '';
    sentToS3.clear();
  };
  upload.onclick = async () => {
    upload.disabled = true;
    try {
      snapshot = await viewer.captureMaskPair();
      uploaded = false;
      dialog.querySelector('.maskUploadFiles').textContent = snapshot.files.map(file => file.name).join(' and ');
      status.textContent = '';
      updateFields();
      dialog.showModal();
    } catch (error) {
      msg(error.message);
    } finally {
      upload.disabled = false;
    }
  };

  function signedPutUrl(value) {
    let url;
    try { url = new URL(value.trim()); } catch { /* Report the same error for all invalid URLs. */ }
    if (!url || url.protocol !== 'https:' || url.username || url.password || url.hash ||
        !url.searchParams.get('X-Amz-Signature')) {
      throw new Error('Enter a valid S3 presigned HTTPS PUT URL for each file.');
    }
    return url;
  }

  form.onsubmit = async event => {
    event.preventDefault();
    if (sending || uploaded || !snapshot) return;
    const destination = fields.destination.value;
    sending = true;
    updateFields();
    status.textContent = 'Uploading…';
    try {
      if (destination === 'hf') {
        const dataset = fields.dataset.value.trim();
        if (!/^[\w.-]+\/[\w.-]+$/.test(dataset) || dataset.split('/').some(part => /^\.+$/.test(part))) {
          throw new Error('Enter an existing dataset in owner/dataset format.');
        }
        const token = fields.token.value.trim();
        if (!/^hf_[a-zA-Z0-9]+$/.test(token)) throw new Error('Enter a Hugging Face write token.');
        const { commitMaskPair } = await import(viewer.maskUploadModule);
        const { scroll, segment, depth, pairId, files } = snapshot;
        const folder = ['annotations', scroll, segment, 'depth-' + depth, pairId]
          .map(part => String(part).replace(/[^a-zA-Z0-9_-]/g, '_')).join('/');
        try {
          await commitMaskPair({ dataset, token, folder, files });
        } catch {
          throw new Error('Hugging Face upload failed. Check the dataset, token permissions and network access.');
        }
      } else {
        const urls = [fields.inkUrl, fields.supervisionUrl].map(input => signedPutUrl(input.value));
        if (urls[0].origin + urls[0].pathname === urls[1].origin + urls[1].pathname) {
          throw new Error('Use two different S3 object keys.');
        }
        const results = await Promise.all(snapshot.files.map(async ({ name, blob }, index) => {
          const url = urls[index].href;
          if (sentToS3.get(name) === url) return null;
          try {
            const response = await fetch(url, { method: 'PUT', body: blob, credentials: 'omit', redirect: 'error' });
            if (!response.ok) return name + ' (HTTP ' + response.status + ')';
            sentToS3.set(name, url);
            return null;
          } catch {
            return name + ' (check bucket CORS and network access)';
          }
        }));
        const failures = results.filter(Boolean);
        if (failures.length) {
          throw new Error((2 - failures.length) + ' of 2 files uploaded. Retry ' + failures.join(', ') + '.');
        }
      }
      uploaded = true;
      fields.token.value = fields.inkUrl.value = fields.supervisionUrl.value = '';
      sentToS3.clear();
      status.textContent = 'Both masks uploaded.';
    } catch (error) {
      status.textContent = error.message;
    } finally {
      sending = false;
      updateFields();
    }
  };
}, { once: true });
