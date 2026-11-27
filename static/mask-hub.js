import { commit } from '@huggingface/hub';

export async function commitMaskPair({ dataset, token, folder, files }) {
  const result = await commit({
    repo: { type: 'dataset', name: dataset },
    accessToken: token,
    title: 'Upload ink and supervision masks',
    useXet: false,
    operations: files.map(({ name, blob }) => ({
      operation: 'addOrUpdate',
      path: folder + '/' + name,
      content: blob,
    })),
  });
  if (!result?.commit?.oid) throw new Error('Hugging Face did not confirm the commit');
}
