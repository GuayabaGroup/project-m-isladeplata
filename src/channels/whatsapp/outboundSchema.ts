import { z } from 'zod';
import type { OutboundMessageDto } from '../../core/types/OutboundMessage.js';

/**
 * Validación del contrato S2S `POST /api/v1/outbound/messages`.
 *
 * Acepta el wire format snake_case que envía Guacuco y lo transforma al
 * `OutboundMessageDto` camelCase de `core/`. El emisor se resuelve por `role`
 * (staff|client); para compat con Guacuco también acepta `user_type`
 * (staff|owner|client) y colapsa `owner → staff` en UN solo lugar (servidor).
 *
 * Los campos interactivos anidados van en camelCase (contrato nuevo, sin
 * legacy que respetar): `buttonLabel`, `displayText`.
 */

const recipientBase = {
  to: z.string().min(1),
  platform_id: z.number().int().positive(),
  role: z.enum(['staff', 'client']).optional(),
  user_type: z.enum(['staff', 'owner', 'client']).optional(),
  idempotency_key: z.string().min(1).optional(),
};

const textVariant = z.object({
  ...recipientBase,
  type: z.literal('text'),
  text: z.object({
    body: z.string().min(1),
    preview_url: z.boolean().optional(),
  }),
});

const templateVariant = z.object({
  ...recipientBase,
  type: z.literal('template'),
  template: z.object({
    name: z.string().min(1),
    lang_code: z.string().min(1),
    parameters: z.array(z.object({ type: z.literal('text'), text: z.string() })).default([]),
    buttons: z
      .array(z.object({ index: z.number().int().min(0).max(9), payload: z.string().min(1) }))
      .optional(),
  }),
});

const interactiveVariant = z.object({
  ...recipientBase,
  type: z.literal('interactive'),
  interactive: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('buttons'),
      body: z.string().min(1),
      buttons: z.array(z.object({ id: z.string().min(1), title: z.string().min(1) })).min(1),
    }),
    z.object({
      kind: z.literal('list'),
      list: z.object({
        body: z.string().min(1),
        buttonLabel: z.string().min(1),
        rows: z
          .array(
            z.object({
              id: z.string().min(1),
              title: z.string().min(1),
              description: z.string().optional(),
            }),
          )
          .min(1),
      }),
    }),
    z.object({
      kind: z.literal('cta'),
      cta: z.object({
        text: z.string().min(1),
        url: z.string().url(),
        displayText: z.string().min(1),
      }),
    }),
  ]),
});

const mediaVariant = z.object({
  ...recipientBase,
  type: z.literal('media'),
  media: z.object({
    kind: z.enum(['image', 'document']),
    link: z.string().url(),
    caption: z.string().optional(),
    filename: z.string().optional(),
  }),
});

const rawSchema = z.discriminatedUnion('type', [
  textVariant,
  templateVariant,
  interactiveVariant,
  mediaVariant,
]);

type RawOutbound = z.infer<typeof rawSchema>;

/** staff|owner → staff, client → client. */
function resolveRole(data: RawOutbound): 'staff' | 'client' | null {
  if (data.role) return data.role;
  if (data.user_type) return data.user_type === 'client' ? 'client' : 'staff';
  return null;
}

export const outboundMessageSchema = rawSchema
  .superRefine((data, ctx) => {
    if (resolveRole(data) === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['role'],
        message: 'Either "role" or "user_type" is required',
      });
    }
  })
  .transform((data): OutboundMessageDto => {
    // `resolveRole` ya validado non-null por el superRefine anterior.
    const role = resolveRole(data) as 'staff' | 'client';
    const base = {
      to: data.to,
      role,
      platformId: data.platform_id,
      ...(data.idempotency_key ? { idempotencyKey: data.idempotency_key } : {}),
    };

    switch (data.type) {
      case 'text':
        return {
          ...base,
          type: 'text',
          text: {
            body: data.text.body,
            ...(data.text.preview_url !== undefined ? { previewUrl: data.text.preview_url } : {}),
          },
        };
      case 'template':
        return {
          ...base,
          type: 'template',
          template: {
            name: data.template.name,
            langCode: data.template.lang_code,
            parameters: data.template.parameters,
            ...(data.template.buttons ? { buttons: data.template.buttons } : {}),
          },
        };
      case 'interactive':
        return { ...base, type: 'interactive', interactive: data.interactive };
      case 'media':
        return {
          ...base,
          type: 'media',
          media: {
            kind: data.media.kind,
            link: data.media.link,
            ...(data.media.caption ? { caption: data.media.caption } : {}),
            ...(data.media.filename ? { filename: data.media.filename } : {}),
          },
        };
    }
  });
