import { expect, test } from "bun:test"
import { enterpriseSpamProbability, ENTERPRISE_SPAM_MODEL } from "./enterprise-spam"
import { enterpriseEmailContent, handleEnterpriseRequest } from "./enterprise"

const submission = {
  name: "Fake Visitor",
  role: "Engineering lead",
  company: "Example Test Company",
  email: "fake-visitor@example.test",
  message: "We need SSO for 200 developers.",
}

const score = (probability: unknown) =>
  Response.json({ model: ENTERPRISE_SPAM_MODEL, answers: { spam: { type: "noul", noul: probability } } })

test("scores a submission through the System One gateway", async () => {
  const requests: Request[] = []
  const probability = await enterpriseSpamProbability(submission, {
    inferenceUrl: "https://opencode.test/inference",
    apiKey: "test-key",
    fetch: async (request) => {
      requests.push(request)
      return score(0.97)
    },
  })

  expect(probability).toBe(0.97)
  expect(requests).toHaveLength(1)
  expect(requests[0].url).toBe("https://opencode.test/inference/systemone/v1/systemone")
  expect(requests[0].headers.get("authorization")).toBe("Bearer test-key")
  const body = await requests[0].json()
  expect(body.model).toBe(ENTERPRISE_SPAM_MODEL)
  expect(body.state.submission).toMatchObject({ email: submission.email, message: submission.message })
  expect(body.questions.spam.type).toBe("noul")
})

test("returns no score when the gateway fails, times out, or answers without a probability", async () => {
  const options = { inferenceUrl: "https://opencode.test/inference", apiKey: "test-key" }
  const failures = [
    async () => new Response("nope", { status: 401 }),
    async () => {
      throw new Error("network")
    },
    async () => score("high"),
    async () => score(1.5),
    async () => Response.json({ answers: {} }),
    (request: Request) =>
      new Promise<Response>((_, reject) =>
        request.signal.addEventListener("abort", () => reject(request.signal.reason)),
      ),
  ]
  for (const fetch of failures) {
    expect(await enterpriseSpamProbability(submission, { ...options, timeoutMs: 20, fetch })).toBeUndefined()
  }
})

test("returns no score when the gateway is not configured", async () => {
  expect(await enterpriseSpamProbability(submission, { inferenceUrl: "", apiKey: "test-key" })).toBeUndefined()
})

const submit = async (spamProbability: () => Promise<number | undefined>) => {
  const leads: Record<string, unknown>[] = []
  const response = await handleEnterpriseRequest(
    new Request("http://localhost/api/enterprise", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...submission, alias: "" }),
    }),
    {
      spamProbability,
      salesforceSubmit: async (payload) => {
        leads.push(payload)
        return true
      },
      notifications: false,
      accountLookup: async () => null,
    },
  )
  return { status: response.status, body: await response.json(), leads }
}

test("confident spam gets the normal success response and never reaches Salesforce", async () => {
  const result = await submit(async () => 0.95)
  expect(result.status).toBe(200)
  expect(result.body).toMatchObject({ success: true })
  expect(result.leads).toHaveLength(0)
})

test("uncertain, missing, or failed scores still create the lead", async () => {
  for (const spamProbability of [
    async () => 0.6,
    async () => undefined,
    async () => {
      throw new Error("classifier down")
    },
  ]) {
    const result = await submit(spamProbability)
    expect(result.status).toBe(200)
    expect(result.leads).toHaveLength(1)
  }
})

test("the sales inbox email escapes submitted HTML", () => {
  const content = enterpriseEmailContent({
    name: "<b>Name</b>",
    role: "Role",
    email: "fake-visitor@example.test",
    message: `<script>alert("x")</script> & <img src=x onerror=alert(1)>`,
    alias: "",
  })
  expect(content).not.toContain("<script>")
  expect(content).not.toContain("<img")
  expect(content).not.toContain("<b>")
  expect(content).toContain(
    "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &lt;img src=x onerror=alert(1)&gt;",
  )
  expect(content).toContain("&lt;b&gt;Name&lt;/b&gt;<br>")
})
