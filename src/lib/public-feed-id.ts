import { z } from 'zod';

export const MAX_PROVIDER_SOURCE_LENGTH = 100;
export const MAX_PROVIDER_EXTERNAL_ID_LENGTH = 200;
// encodeURIComponent expands one well-formed UTF-16 code unit by at most nine
// ASCII characters. The two prefixes/separators add ten more characters.
export const MAX_EXTERNAL_PUBLIC_FEED_ID_LENGTH = 10
  + 9 * (MAX_PROVIDER_SOURCE_LENGTH + MAX_PROVIDER_EXTERNAL_ID_LENGTH);

function isUriEncodable(value: string): boolean {
  try {
    encodeURIComponent(value);
    return true;
  } catch {
    return false;
  }
}

export const ProviderSourceSchema = z.string()
  .min(1)
  .max(MAX_PROVIDER_SOURCE_LENGTH)
  .refine(isUriEncodable, 'source must contain well-formed Unicode');
export const ProviderExternalIdSchema = z.string()
  .min(1)
  .max(MAX_PROVIDER_EXTERNAL_ID_LENGTH)
  .refine(isUriEncodable, 'externalId must contain well-formed Unicode');

export function externalPublicFeedId(source: string, externalId: string): string {
  const validatedSource = ProviderSourceSchema.parse(source);
  const validatedExternalId = ProviderExternalIdSchema.parse(externalId);
  return `external:${encodeURIComponent(validatedSource)}:${encodeURIComponent(validatedExternalId)}`;
}
