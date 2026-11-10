# Native résumé import and private access

## Implemented

- Server-minted private résumé uploads carry verified uploader/tenant custody.
- Attach/create/update paths cannot claim another uploader’s document or repin a
  file already bound to another candidate.
- Bound downloads use current candidate visibility, recruiter ownership ceilings
  and current staff/account scope. An old uploader grant cannot override these.
- Erased, replaced and employer-hidden documents are denied. Browser responses
  are private and non-cacheable; the normal UI download uses the authenticated
  storage endpoint.
- Bulk imports preserve existing document pointers and manually entered skills.
  New parsed skills merge atomically. Storage failures are explicit failures.
- S3 tag values use versioned URL-safe encoding. Candidate and upload-tenant
  bindings are separate tags to respect the 256-character limit.
- Upload and initial ownership tags are written atomically. Missing AWS tagging
  rights return an actionable 503 rather than creating a new unowned upload.

## Verification and limits

Isolated HTTP/database tests cover the import and authorization contracts.
They use mocked S3 transport and AI responses, with a valid fictional DOCX for
text extraction. They are not live provider or cost evidence.

The avatar claim-seal regression suite also passes; its separate namespace
protections were preserved.

Real S3 testing first rejected raw JSON tag values. After correcting that format,
AWS reported missing `s3:PutObjectTagging`. A separate read-only probe confirmed
`s3:GetObjectTagging` also returns AccessDenied. Live secure PDF/DOCX
upload/download verification therefore remains **blocked**, not passed.
Failed live attempts remain journaled; they did not reach résumé AI parsing.
No candidate email, interview, hiring outcome or fee was created.

Existing untagged historical documents are not retroactively granted access
based on a user-editable pointer. Do not backfill old Linx records.

## AWS administrator action

Allow these actions for the configured private résumé object prefix:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["s3:GetObjectTagging", "s3:PutObjectTagging"],
    "Resource": "arn:aws:s3:::<configured-bucket>/<configured-private-prefix>/resumes/*"
  }]
}
```

Replace the placeholders in the AWS administrator’s environment, not in chat.
No new access key or LLM/provider configuration change is required.
Existing object read/write permissions must remain in place.

The separate machine-to-machine importer still needs a configured
`LEXY_IMPORT_API_KEY` before external clients can use it. Its test-process
credential does not enable the running service.
