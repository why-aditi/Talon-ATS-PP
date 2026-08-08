import { S3Client } from '@aws-sdk/client-s3';
import { asClass, asFunction, type AwilixContainer } from 'awilix';
import { InMemoryFileStore, S3FileStore, type FileStore } from './file-store.js';
import { ImportsRepository } from './repository.js';
import { ImportsService } from './service.js';

/**
 * The store is registered as a function so a test can swap the whole adapter without
 * a bucket — the same reason the identity provider sits behind an interface.
 */
export function registerImports(container: AwilixContainer): void {
  container.register({
    importsService: asClass(ImportsService),
    importsRepository: asClass(ImportsRepository),
    fileStore: asFunction((): FileStore => {
      const bucket = process.env['TALON_UPLOADS_BUCKET'];
      // No bucket, no S3 client. Reaching for AWS with an invented bucket name is how
      // a misconfigured environment produces an obscure 403 instead of an obvious gap.
      if (!bucket) return new InMemoryFileStore();
      const region = process.env['AWS_REGION'] ?? 'us-east-1';
      const endpoint = process.env['AWS_ENDPOINT_URL'];
      return new S3FileStore(
        new S3Client({ region, ...(endpoint ? { endpoint, forcePathStyle: true } : {}) }),
        bucket,
      );
    }).singleton(),
  });
}
