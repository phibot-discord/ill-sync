export type UnpackEnv = {
	UNPACK_URL?: string;
	UNPACK_SECRET?: string;
	SYNC_SECRET?: string;
};

export async function forwardUnpack(
	env: UnpackEnv,
	body: string,
	fetchImpl: typeof fetch = fetch,
): Promise<Response> {
	const dest = env.UNPACK_URL?.trim();
	if (!dest) {
		return Response.json({ skipped: true, reason: "UNPACK_URL unset" });
	}
	const secret = (env.UNPACK_SECRET || env.SYNC_SECRET || "").trim();
	let res: Response;
	try {
		res = await fetchImpl(dest, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-phi-proxy-key": secret,
			},
			body: body || "{}",
			signal: AbortSignal.timeout(10_000),
		});
	} catch (err) {
		return Response.json(
			{ error: err instanceof Error ? err.message : String(err) },
			{ status: 504 },
		);
	}
	return new Response(await res.text(), {
		status: res.status,
		headers: {
			"content-type": res.headers.get("content-type") || "application/json",
		},
	});
}
