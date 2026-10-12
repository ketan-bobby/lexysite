import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";

const target = process.argv[2];
const secretId = "lexy/production/inbound-email";
const region = process.env.AWS_REGION || "us-east-1";

if (!["index", "worker", "verify"].includes(target)) {
  console.error("Usage: node start-with-secrets.mjs index|worker|verify");
  process.exit(2);
}

try {
  const client = new SecretsManagerClient({ region });
  const result = await client.send(
    new GetSecretValueCommand({ SecretId: secretId }),
  );

  if (!result.SecretString) {
    throw new Error("SecretString is missing");
  }

  const parsed = JSON.parse(result.SecretString);
  const secret = parsed.INBOUND_EMAIL_SECRET;

  if (typeof secret !== "string" || secret.length === 0) {
    throw new Error("Required secret field is missing or empty");
  }

  process.env.INBOUND_EMAIL_SECRET = secret;

  if (target === "verify") {
    console.log("Secrets Manager retrieval and validation succeeded; application was not started.");
  } else {
    console.log("Secrets Manager retrieval succeeded; starting application.");
    await import(
      target === "index" ? "./dist/index.mjs" : "./dist/worker.mjs"
    );
  }
} catch (error) {
  console.error(
    "Startup aborted: required secret could not be loaded.",
    error instanceof Error ? error.message : "Unknown error",
  );
  process.exit(1);
}
