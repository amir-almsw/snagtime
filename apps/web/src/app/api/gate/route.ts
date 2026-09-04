import { apiError, jsonBody, ok } from "@/server/http";
import { AppError } from "@/server/errors";
import { assertSameOrigin } from "@/server/auth/session";
import { createGateToken, gateCookieName, gateCookieOptions, verifyGatePassword } from "@/server/auth/client-gate";
import { clientGateInput } from "@/server/validation";
import { clientAddress, enforceRateLimit } from "@/server/rate-limit";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    // Rate limit before the deliberately slow scrypt comparison so the gate cannot become a CPU exhaustion vector.
    await enforceRateLimit(`gate:ip:${clientAddress(request)}`, 5, 300_000);
    await enforceRateLimit("gate:global", 200, 3_600_000);
    const { password } = clientGateInput.parse(await jsonBody(request));
    if (!(await verifyGatePassword(password))) {
      console.warn("client_gate.password_rejected", { address: clientAddress(request) });
      throw new AppError("AUTHENTICATION_FAILED", "That password is not correct.", 401);
    }
    const response = ok({ authorized: true as const });
    response.cookies.set(gateCookieName(), createGateToken(), gateCookieOptions);
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) { return apiError(error); }
}

export async function DELETE(request: Request) {
  try {
    assertSameOrigin(request);
    const response = ok({ cleared: true as const });
    response.cookies.set(gateCookieName(), "", { ...gateCookieOptions, maxAge: 0 });
    return response;
  } catch (error) { return apiError(error); }
}
