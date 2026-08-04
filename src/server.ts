#!/usr/bin/env node

/**
 * QualityControl MCP Server â€” HTTP/SSE Transport
 *
 * VersiÃ³n para deploy en servidor con PM2.
 * Expone el MCP via Streamable HTTP en un puerto configurable.
 * Incluye OAuth 2.1 para compatibilidad con Claude.ai web.
 *
 * Endpoints:
 *   POST /mcp   â€” JSON-RPC messages (MCP protocol)
 *   GET  /mcp   â€” SSE stream (server â†’ client notifications)
 *   DELETE /mcp â€” Close session
 *   GET  /health â€” Health check para PM2/balanceador
 *   GET  /.well-known/oauth-authorization-server â€” OAuth metadata
 *   GET  /authorize â€” OAuth authorization endpoint
 *   POST /token â€” OAuth token endpoint
 *   POST /register â€” OAuth dynamic client registration
 */

import express from "express";
import cors from "cors";
import { randomUUID, createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { tools, executeTool } from "./tools/index.js";
import { runWithApiKey } from "./tools/request-context.js";
import { logger } from "./logger/index.js";
import { apiClient } from "./api/client.js";
import { sessionManager } from "./sessions/manager.js";
import { isTokenRevoked, associateToken, clearRevoked, getAuthVersion, restoreAuthVersion } from "./auth/token-store.js";
import { cacheManager } from "./cache/manager.js";

// â”€â”€â”€ Config â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const PORT = parseInt(process.env.MCP_PORT || "3100", 10);
const HOST = process.env.MCP_HOST || "0.0.0.0";
const BASE_URL = process.env.MCP_BASE_URL || "https://qa.cogrowers.cl/mcp/qualitycontrol";
const OAUTH_LOGO_URL = process.env.OAUTH_LOGO_URL || "https://web.cogrowers.cl/lovable-uploads/e945d53e-8ff3-45c8-b232-9e290210403c.png";
const BASE_PATH = new URL(BASE_URL).pathname.replace(/\/+$/, "") || "/";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ASSETS_DIR = join(__dirname, "../public/assets");

// Favicon desde Google Drive
const FAVICON_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAlEAAAIHCAYAAAC/qwk0AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAALiMAAC4jAXilP3YAABdfSURBVHhe7d1NchVXmoDh76QIuwclrsb8hFQr4NZAeIhqBaZXYNUKil5A+UqwgKZWYHkFRa3A8hA0sLSCEmFXTwvsHlQ7rPx6gLAhESAd/dybmc8z83flCCIy0H05efJkBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAi6V0BwDAuNycPNrozubpny//studLSIRBQADc2Mym5a4ttK07TQiVrKUtRKxFhGRmWullNXu/7NIvv/xy170SS/+kADAu1Yns7Wjo6VpKTmNUjb6EEinIaIAgAu1OpmttW1zP0vZiMzpEILpJCIKADi3G5PZtMlmMzLuDzWaukQUAFDleMVpMyM2xxJObxJRAMCZ3Jw82iiZD0rE593PxkREAQCncnPyaKPJ3IqIe93PxkhEAQAfdGMymy7l0mPx9La+RFTTHQAAl2t1Mlu5dX378VIufSeg+ktEAcAVujl5tHHUNvslyp+7n9EvIgoArsjt5e2tJvObMT5xN0S9uOcIAH22OpmtHOXSztifujste6IAgFidzFbattkVUMMjogDgktyYzKZHbXMYpdzpfkb/iSgAuAQ3JrNp0za7pZRJ9zOGQUQBwAVbncxWmrZ5IqCGTUQBwAX6dQ+UJ/AGT0QBwAU6yqUde6DGQUQBwAW5vby95Sm88RBRAHABbkxm0yhl1p0zXCIKAM7p9Uby7pxhE1EAcE5H2WzZSD4+IgoAzuHGZDb1MuFxElEAcA5LufS4O2McRBQAVLr1u4f3I+Jed844iCgAqFXSKtSIiSgAqHB7+eGmzeTjJqIAoEo+6E4YFxEFAGd0c/Jow6tdEFEAcEYlrUIhogDgTFYnszXvxyNEFACcTds2m90Z4ySiAOAMMkJEESGiAOD0bkxmU8ca8JqIAoBTatKtPH4jogDgtDLud0eMl4gCgFNwK48uEQUAp7DUNhvdGeMmogDgNEpxK4+3iCgAOJ173QHjJqIA4CNuTh65lcc7RBQAfETTtiKKd4goAPiYUkQU7xBRAPARmTntzkBEAcAHrE5ma6WUSXcOIgoAPuDoaMkqFCcSUQDwAaW4lcfJRBQAfECWIqI4kYgCgA8omWvdGYSIAoCPKOVOdwQhogDg/VYnM6tQvJeIAoD3+CWuiSjeS0QBwHs0bWtTOe8logDg/Va6A3hNRAHAe2QpbufxXiIKAN6jRIgo3ktEAQBUEFEA8H73ugN4TUQBAFQQUQAAFUQUAJzgxmTmjCg+SEQBwAlKXHNGFB8kogAAKogoAIAKIgoATlCO0u08PkhEAcAJSkkby/kgEQUAUEFEAQBUEFEAABVEFABABREFAFBBRAEAVBBRAAAVRBQAQAURBQBQQUQBAFQQUQAAFUQUAEAFEQUAUEFEAQBUEFEAABVKdwDAsN2YzKYlrq28OWvadhoRb83m7fufZlvd2VW6vby9FaXMunMu3/c/ftmLPunFHxKAj1udzFZ+iWvTps21iFzLEislyjQiIjOnpZRJ9/9ZZPP+IhVR8zPva39avfhDAvC2G5PZdKldmmbJaYky7WMkfcy8v0hF1PzM+9qfVi/+kABj9yqamo0sZSMyN4YWTCeZ9xepiJqfeV/707KxHGBB3frdw/u3rj/cubW8fbiUS99FKf9dIj4fQ0BBH4gogAVyYzKb3rq+/fjW8vaL0sTfSsQXpZTV7s8B8yeiABbA7eWHm7evP9xdyqXvSpQ/W22CxSeiAObo9vLDzVvL24dR4quIuNf9HFhcIgpgDm5OHm3cXt7ejxJfuV0H/SSiAK7Q6mS2cuv6wydN5jdRyp3u50B/iCiAK3Lrdw/vH7XNYYn4vPsZ0D8iCuAK3Lr+cKc08TcbxmE4RBTAJVqdzFZuL2/vl4gvup8B/SaiAC7JjclsetQ2+/Y+wTCJKIBLcGMymzZts+vJOxguEQVwwd4IKPufYMBEFMAFWp3MVgQUjIOIArggq5PZSiugYDREFMAFOcqlxzaRw3iIKIALcHv54aZjDGBcRBTAOa1OZmsZ+bg7B4ZNRAGcU5tLO/ZBwfiIKIBzuPW7h/cj4l53DgyfiAKotDqZrURxGw/GSkQBVGrb5oETyWG8RBRAhdXJbCUjHnTnwHiIKIAKx6tQNpPDiIkogAoZsdmdAeMiogDO6Pbyw017oQARBXBWxSoUIKIAzmR1MltzLhQQIgrgbNq2ud+dAeMkogDOxq08IEJEAZze6mS2FqXc6c6BcRJRAKfkVh7wJhEFcEpZykZ3BoyXiAI4rUwRBfxKRAGcwo3JbOo1L8CbRBTAKSy1jVUo4C0iCuAU7IcCukQUwGlkTrsjYNxEFMApeOEw0CWiAD7i5uSRW3nAO0QUwEc0ba51ZwAiCuCjRBTwLhEF8DGezANOIKIAACqIKICPu9cdAIgoAIAKIgrgA1YnM5vKgROJKIAP+CWuiSjgRCIKAKCCiAL4gHKUK90ZQIgogA8rxYuHgZOJKACACiIKAKCCiAIAqCCiAAAqiCgAgAoiCgCggogCAKggogAAKogoAIAKIgoAoIKIAgCoIKIAACqIKACACiIKAKCCiAIAqCCiAAAqiCgAgAoiCgCggogCAKggogAAKogoAIAKIgoAoIKIAgCoIKIAACqIKACACiIKAKCCiAIAqCCiAAAqiCgAgAoiCgCggogCAKggogAAKogoAIAKIgoAoIKIAgCoIKIAACqIKACACiIKAKCCiAIAqCCiAAAqiCgAgAoiCgCggogCAKggogAAKpTuABifm5NHG93Zm5q2/eDnV+H7n2Zb3dlVuL28vRWlzLpzLt/3P3451+8o135+5n3tT6sXf0jgbF5H0ev4yVLWSsRaRERkrkQpdzr/y8Kb1y9VX6TzM69r/pprPz/zvvan1Ys/JPCu1cls5Ze4Nm3aduN1JGXmtJQy6f7sEMzrl6ov0vmZ1zV/zbWfn3lf+9OyJwp64sZkNr29vP3g1vWHT24tbx+2ufSvJvObKGVWIr6IiHtDDSiARSSiYEGtTmYrt5cfbt66/nDn1vL2i6Vc+i5K+e8S8XkpZbX78wBcLREFC+SNcHrS5tK/osRXJeILK0wAi0dEwQJYnczWbl1/uHPUNofH4fR592cAWCwiCubo5uTRxvGq0z+sOAH0i4iCOVidzNZuX3+422R+Y9UJoJ9EFFyhV3uetrfaXPpHRNzrfg5Af4gouCI3J482jtpm37kzAMMgouAK3F7e3moyv3E0AcBwiCi4RKuT2cqt6w93rD4BDI+IgkuyOpmttG2ze3yaOAADI6LgErwOqD6+6BeA0xFRcMEEFMA4iCi4YEe5tCOgAIZPRMEFur28veXwTIBxEFFwQW5OHm14Cg9gPEQUXIDVyWyltO1Odw7AcIkouABH2Ww5SBNgXEQUnNPqZLZWovy5Owdg2EQUnNNRLm11ZwAMn4iCc3i1CuVEcoAxElFwDlahAMZLREGl1clsxSoUwHiJKKjUts1mdwbAeIgoqCeiAEZMREGF1clszfvxAMZNREGFtl3a6M4AGBcRBRWyxP3uDIBxEVFQI9NKFMDIiSg4oxuT2bSUMunOARgXEQVntNQuTbszAMZHRMGZ5Vp3AsD4iCg4q1LshwJARMGZZa50RwCMj4iCs3LIJgAiCs5mdTKzCgVAhIiCs/klrnkyD4AIEQUAUEdEAQBUEFFwBk3bup0HQISIgjOzsRyACBEFAFBHRAEAVBBRAAAVRBQAQAURBQBQQUQBAFQQUQAAFUQUAEAFEQUAUEFEAQBUEFEAABVEFABABREFAFBBRAEAVBBRAAAVRBQAQAURBQBQQUQBAFQQUQAAFUQUAEAFEQUAUEFEAQBUEFEAABVEFABABREFAFBBRAEAVBBRAAAVRBQAQAURBQBQQUQBAFQQUQAAFUQUAEAFEQUAUEFEAQBUEFEAABVEFABABREFAFBBRAEAVBBRAAAVRBQAQAURBQBQQUQBAFQQUQAAFUQUAEAFEQUAUEFEAQBUEFEAABVEFABABREFAFBBRAEAVBBRAAAVRBQAQAURBQBQQUQBAFQQUQAAFUQUAEAFEQUAUEFEAQBUEFEAABVEFABABREFAFBBRAEAVBBRAAAVRBQAQAURBQBQQUQBAFQQUQAAFUQUAEAFEQUAUEFEAQBUEFEAABVEFABABREFAFBBRAEAVBBRAAAVRBQAQAURBQBQQUQBAFQQUQAAFUQUAEAFEQUAUEFEAQBUEFEAABVEFABABREFAFBBRAEAVBBRAAAVRBQAQAURBQBQQUQBAFQQUQAAFUQUAEAFEQUAUEFEAQBUEFEAABVEFABABREFAFBBRAEAVBBRAAAVRBQAQAURBQBQQUQBAFQQUQAAFUp30Ff52WcbkflNd05EZh6UUl5ExGFkHkbEYTTNYXn6dLf7s3zY7eXtrShl1p1z+b7/8cu5/L5yzednXtf8Ndd+fuZ97U/LStQIlFLuRMS9iPgiSplFKV9F5jd592626+v7effuTq6vb+Znn611/18A4GQiauSOA+uL47D6R7u+fph37+7k3bv3uz8LAPxGRPGWUspqRHwREX/Lu3dfCCoAOJmI4kMmr4OqXV8/zPX1Lbf8AOAVEcWplFJWo5RZZP4j797dEVMAjJ2IosYXxzG1m+vr0+6HADAGIorzuBelfGdlCoAxElFchFcrU+vrW3nnzkr3QwAYIhHFxSlllp98su9pPgDGQERxoY6PSPhbu77+xKoUAEMmorgUpZTP49NPD/Ozzza6nwHAEIgoLtMkMr/J9fWt7gcA0HciistXyizv3t11ew+AIRFRXJV7+ckn+86VAmAoRBRX5vjUcwd0AjAIIoqrNolSvsv19c3uBwDQJyKK+SjlKyEFQJ+JKOZHSAHQYyKK+RJSAPSUiGL+SvnKoZwA9I2IYjFkPvHUHgB9IqJYFJOM8L49AHpDRLEwSimr+cknu905ACwiEcVCKaXcadfXH3fnALBoRBQLp5Ty57x79353DgCLRESxqHbsjwJgkYkoFtUkPv30SXcIAItCRLHI7rmtB8CiElEsOrf1AFhIIopFN4lPP/W0HgALR0TRB184zRyARSOi6IdSrEYBsFBEFH1xz0uKAVgkIor+yNzqjgBgXkQUfWI1CoCFIaLoF6tRACwIEUXf3MvPPlvrDgHgqoko+sdqFAALQETRR/edYg7AvIko+mgSn3zinXoAzJWIopcyQkQBMFciil4qpXzulh4A8ySi6C+39ACYIxFFb7mlB8A8iSh6q5TyeXcGAFdFRNFrXgMDwLyIKPqtbUUUAHMhoui3UkQUAHMhoui7e90BAFwFEUXv5fr6tDsDgMsmoui/Uta6IwC4bCKK/su0EgXAlRNR9F5GiCgArpyIovdKKd6hB8CVE1EMgZUoAK6ciGIIJt0BAFw2EQUAUEFEMQjOigLgqokohqFpbC4H4EqJKACACiIKAKCCiAIAqCCiAAAqiCgAgAoiCgCggogCAKggogAAKogoAIAKIgoAoIKIAgCoIKIAACqIKACACiIKAKCCiAIAqCCiAAAqiCgAgAoiCgCggogCAKggogAAKogoAIAKIgoAoIKIAgCoIKIAACqIKACACsOJqLZ90R0BAFyWwURU2dvb784AAC7LYCIKAOAqDSqiMvOgOwMA+iMzn3dni2pQEVVKsS8KAHqslHLYnS2qQUVUZtoXBQBciUFFVPSoXgGAfhtURJVSrEQBAFdiUBEV//63iAIArsSgIqocHLzwhB7AIHzbHTASmbvd0aIaVESFW3oAwBUZXET1qWABgP4aXkQ1jYgCgN7qz5P2g4uo8vTpoX1RANBPbSOi5s1qFABwqQYZUSVipzsDABbfP1/+pTcLIcOMqL29/T69wBCAt2WEd6Gy8AYZUWE1CqDXinehjlPP9jQPNqKiaUQUAPRJKb1agRxsRJWnTw+deAsAPdKzsx4HG1HHHncHACy+1pl/Y2UlalGUZ8+e2GAOAP3QNk2v9sINOqLi1Qbzre4MgMV2LX7p1ZcpF6Nv1334EbW3txMRL7tzABbX85fbvbqtw/ll5su+XffBR1S8Om/EahRAX/TsMXcuRimlV6tQMZaIap49e2xvFEA/ZOnPu9O4QD17Mi/GElFhbxT0Wma6JT8iDtocpz4+kTmeiHq1N8q5UdBDfVzmp16m6z1GfdtUHmOKqIiIyHzQHQGwWJaWjnr3Zco5ZR70bVN5jC2ijl9M/NfuHFhsGWGPzEgcP6Hleo9MlujdrbwYW0RFRJSff96yyRz6pWT6Uh2LUnr5Zco5tf287uOLqIODF6VpNrtzYJF5WmssSg+f0OJ8MvPlD//75ZPuvA9GF1Hx6uXEu5G53Z0Di6ltRNRYHDWtiBqbHq8+jjKi4tX+qK10oBv0wj9f/qW3v2Q5vcx8/j8vt20qH5mS0ctVqBhzRMWr/VEbXgkDC84/dsajxysS1MnMl01zJKL6qBwcvIjMje4cWBzpjKjxaPu7IkGlUp708WiD10YdUXF87EFk/qk7BxZDyX4++szZ9HlzMfWylJ3urE9GH1HxKqR2bDSHxdTnpX7OoESvv0w5u8x83vf9jiLqWNnb24qIr7tzYI56eooxZ7dU2sfdGcNWovT+nbYi6g3l2bNNIQULxerEOHzrlPJxyczn3//0Ze//fouoDiEFi6Np2t7/kuXj2tL/FQnOZgirUCGiTiakYP4y4mu38kbh277vi+FshrIKFSLq/cqzZ5teVgzz05Yje2RGwCrUCGV50B31lYj6gGZv74HjD+DqZcTfnVw9fBnxtVWo0fl2SEdZiKiPOD7+4A9ONoers1SOBvMvVU6WmS9d53HJzJdNOdrszvtMRJ1C2dvbj1Km3rUHVyBz25NaI5Bl0563cSlRHgzt77aIOqXy9Olhs7c3tU8KLlHmQdM4L2joMuLrId3S4eMy4uuhbCZ/k4g6o2Zv70GU8sfMfN79DKiXmS+PmtbqxNBlHriNNzIDvuYiqkJ5+nS3/PyzVSm4QCXKA5vJhy0zXzZNuyGUR+TV6vJgr7mIqlQODl68sSplrxScR8afhrjUz28y82U74C9T3jWG1WURdU7l6dPdZm9vGpl/cosPKgiowcvM523TblhpHJHMg6WmnQ79mouoC1L29nbKzz9PI3PbcQhwSgJq+EbyZcobfruFN6gn8U4ioi5QOTh4Ufb2tuL//m8tI/7LyhScLDOfH5WjPwioYcvIv37/02w65Ns5vG1s11xEXYJycPCiefbscbO3t3Z84vm33Z+BscqIv1uZGLbMfJlt/OcPP84G+UQW7xrrNRdRl6zs7e2UZ882opTfZ+ZfrU4xWpkHbSl//OHHL++P5V+pY5SRf11q2jXnQI3HmK+5iLoix4d1PjhenfqDoGIsMvP5q71Ps6n3pA1XRnzdlKPf//Dj7IFIHgfXXETNRdnb2/81qEr5/fEtv69FFUOSEX9vS/njDz/N1ux9GqbMfBmZ26++SL/cHMNG4rHLzJe/xZNrXroD5ivv3FmJ//iPabTtRpSyFhFrETGNiEn3Z3lDKX8sT59e+irH7eXtrShl1p3zSkb8vWQ8aZqjJ0P5l6lr/rbMfBmlPIk2ngz99o1r/5sh/t2+CCKqR34NLN7173/vl4ODS/+L7ZdqR+ZBltiNtuwuLR3tDvGXq2seERHfZuR+lubJmG7JjvnaZ+bzKGW3ZOwKp/cTUXAGY/2lmpnPSymHGblfsuy3TTkcy5fpmK55Zr4spey/us5x2DbN/liu80nGcu1fX/fI3I0oh01ztDv223SnJaLgDAbzSzXzIEp5+1+Wmb9+WbZNsxsRcS1+ORz7L9O+X/PXAfzrf0e8KJmvj5d40TbNfkTEmGPpfYZ37XO/ZLyIN/6Ou+7nI6IAYAGsTmYrv8S1U23ZED8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIP2/6p6M29e7h4RAAAAAElFTkSuQmCC";

// â”€â”€â”€ Crear servidor MCP â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "qualitycontrol-mcp",
    version: "1.0.0",
  });

  // Registrar todas las herramientas
  for (const tool of tools) {
    const zodShape: Record<string, z.ZodTypeAny> = {};

    for (const [key, propDef] of Object.entries(tool.inputSchema.properties)) {
      const prop = propDef as { type: string; description?: string; enum?: string[] };
      let zodField: z.ZodTypeAny;

      if (prop.enum) {
        zodField = z.enum(prop.enum as [string, ...string[]]);
      } else if (prop.type === "number") {
        zodField = z.number();
      } else {
        zodField = z.string();
      }

      if (prop.description) {
        zodField = zodField.describe(prop.description);
      }

      if (!tool.inputSchema.required.includes(key)) {
        zodField = zodField.optional();
      }

      zodShape[key] = zodField;
    }

    server.tool(
      tool.name,
      tool.description,
      zodShape,
      async (params) => {
        const result = await executeTool(tool.name, params as Record<string, unknown>);
        return result;
      }
    );
  }

  return server;
}

// â”€â”€â”€ Express App â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use("/assets", express.static(ASSETS_DIR));
if (BASE_PATH !== "/") {
  app.use(`${BASE_PATH}/assets`, express.static(ASSETS_DIR));
}

// Map de sesiones activas: sessionId â†’ transport
const transports = new Map<string, StreamableHTTPServerTransport>();

// â”€â”€â”€ OAuth 2.1 (requerido por Claude.ai web) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// Almacenamiento temporal de cÃ³digos de autorizaciÃ³n y tokens
interface AuthCodeData {
  clientId: string;
  redirectUri: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  expiresAt: number;
  apiKey?: string;
  companyName?: string | null;
  deviceCount?: number;
}
interface TokenData {
  clientId: string;
  expiresAt: number;
  authVersion: number;
  apiKey?: string;
  companyName?: string | null;
  deviceCount?: number;
}
const authCodes = new Map<string, AuthCodeData>();
const accessTokens = new Map<string, TokenData>();
const registeredClients = new Map<string, { clientId: string; clientSecret: string; redirectUris: string[] }>();

// ─── Persistencia de tokens OAuth ────────────────────────────────────────────
const TOKEN_STORE_FILE = resolve(process.env.MCP_TOKEN_STORE_FILE || "./data/tokens.json");

function saveTokens(): void {
  try {
    const dir = dirname(TOKEN_STORE_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const payload = {
      version: 1,
      savedAt: new Date().toISOString(),
      authVersion: getAuthVersion(),
      tokens: Array.from(accessTokens.entries()).map(([token, data]) => ({ token, ...data })),
    };
    writeFileSync(TOKEN_STORE_FILE, JSON.stringify(payload, null, 2), "utf8");
  } catch (err) {
    logger.error("TokenStore: error guardando en disco", { error: String(err) });
  }
}

function loadPersistedTokens(): void {
  try {
    if (!existsSync(TOKEN_STORE_FILE)) { logger.debug("TokenStore: no existe archivo, comenzando vacio"); return; }
    const raw = readFileSync(TOKEN_STORE_FILE, "utf8");
    const payload = JSON.parse(raw) as { version: number; authVersion?: number; tokens: Array<{ token: string } & TokenData> };
    if (payload.version !== 1 || !Array.isArray(payload.tokens)) { logger.warn("TokenStore: formato no reconocido, ignorando"); return; }
    // Restaurar authVersion para que los tokens cargados no queden como obsoletos
    if (typeof payload.authVersion === "number") {
      restoreAuthVersion(payload.authVersion);
    }
    let loaded = 0;
    for (const entry of payload.tokens) {
      const { token, ...data } = entry;
      if (token && data.clientId) {
        accessTokens.set(token, data);
        loaded++;
      }
    }
    if (loaded > 0) logger.info(`TokenStore: ${loaded} token(s) restaurado(s) desde disco`);
  } catch (err) {
    logger.warn("TokenStore: error cargando desde disco, comenzando vacio", { error: String(err) });
  }
}

// Cargar tokens persistidos al iniciar
loadPersistedTokens();

// OAuth Server Metadata (RFC 8414)
// Handles both the simple path (Apache strips BASE_PATH) and the
// RFC 8414 path-aware URL that Apache rewrites to BASE_PATH/.well-known/...
const oauthMetadataHandler = (_req: express.Request, res: express.Response): void => {
  res.json({
    issuer: BASE_URL,
    authorization_endpoint: `${BASE_URL}/authorize`,
    token_endpoint: `${BASE_URL}/token`,
    registration_endpoint: `${BASE_URL}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256", "plain"],
    token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
    scopes_supported: ["mcp"],
  });
};
app.get("/.well-known/oauth-authorization-server", oauthMetadataHandler);
if (BASE_PATH !== "/") {
  app.get(`${BASE_PATH}/.well-known/oauth-authorization-server`, oauthMetadataHandler);
}

// Protected Resource Metadata (RFC 9728) — required by MCP spec
const protectedResourceHandler = (_req: express.Request, res: express.Response): void => {
  res.json({
    resource: `${BASE_URL}/mcp`,
    authorization_servers: [BASE_URL],
    bearer_methods_supported: ["header"],
    scopes_supported: ["mcp"],
  });
};
app.get("/.well-known/oauth-protected-resource", protectedResourceHandler);
if (BASE_PATH !== "/") {
  app.get(`${BASE_PATH}/.well-known/oauth-protected-resource`, protectedResourceHandler);
}

// Dynamic Client Registration (RFC 7591)
app.post("/register", (req, res) => {
  const clientId = `client_${randomUUID()}`;
  const clientSecret = `secret_${randomUUID()}`;
  const redirectUris = req.body.redirect_uris || [];
  // Honor the requested auth method — Claude uses "none" (PKCE, no client_secret)
  const requestedAuthMethod = req.body.token_endpoint_auth_method;
  const authMethod = requestedAuthMethod === "none" ? "none" : "client_secret_post";

  registeredClients.set(clientId, { clientId, clientSecret, redirectUris });
  logger.info(`OAuth: Cliente registrado: ${clientId} (auth_method=${authMethod})`);

  const responseBody: Record<string, unknown> = {
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_secret_expires_at: 0,
    redirect_uris: redirectUris,
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: authMethod,
  };
  // Only include client_secret when auth method is not "none"
  if (authMethod !== "none") {
    responseBody.client_secret = clientSecret;
  }

  res.status(201).json(responseBody);
});

// Escapar HTML para prevenir XSS
function escapeHtml(str: string): string {
  return (str ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function normalizeValidationItems(validation: Record<string, unknown>): Record<string, unknown>[] {
  const candidates = [
    validation.dispositivos,
    validation.data,
    validation.items,
    validation.results,
    validation.records,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate.filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null);
    }
  }

  return [];
}

function extractCompanyName(
  validation: Record<string, unknown>,
  devices: Record<string, unknown>[]
): string | null {
  const topLevelNameKeys = ["empresa", "company", "company_name", "cliente", "client", "name"];
  for (const key of topLevelNameKeys) {
    const value = validation[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  const first = devices[0];
  if (!first) return null;

  const nestedNameKeys = ["empresa", "company", "company_name", "cliente", "client", "name"];
  for (const key of nestedNameKeys) {
    const value = first[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  return null;
}

function extractDeviceCount(validation: Record<string, unknown>, devices: Record<string, unknown>[]): number {
  const countKeys = ["total", "count", "total_dispositivos", "total_devices"];
  for (const key of countKeys) {
    const value = validation[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  return devices.length;
}

// Authorization Endpoint â€” GET muestra formulario para ingresar API Key
app.get("/authorize", async (req, res) => {
  const { client_id, redirect_uri, state, code_challenge, code_challenge_method, response_type } = req.query as Record<string, string>;

  if (response_type !== "code") {
    res.status(400).json({ error: "unsupported_response_type" });
    return;
  }

  // ── Auto-login: si client_id parece una API key, intentar validarla directamente ──
  // El usuario puede poner su API key en el campo "OAuth Client ID" del conector de Claude.
  // Si el client_id NO es un UUID registrado por /register, intentamos validarlo como API key.
  const isRegisteredClient = registeredClients.has(client_id);
  if (!isRegisteredClient && client_id && client_id.trim().length > 8) {
    try {
      const autoValidation = await apiClient.validateApiKey(client_id.trim());
      if (autoValidation.success) {
        // API key válida: auto-autorizar sin mostrar formulario
        const normalized = autoValidation as Record<string, unknown>;
        const devices = normalizeValidationItems(normalized);
        const companyName = extractCompanyName(normalized, devices);
        const deviceCount = extractDeviceCount(normalized, devices);

        const code = randomUUID();
        authCodes.set(code, {
          clientId: client_id,
          redirectUri: redirect_uri,
          codeChallenge: code_challenge,
          codeChallengeMethod: code_challenge_method,
          expiresAt: Date.now() + 5 * 60 * 1000,
          apiKey: client_id.trim(),
          companyName,
          deviceCount,
        });

        const redirectUrl = new URL(redirect_uri);
        redirectUrl.searchParams.set("code", code);
        if (state) redirectUrl.searchParams.set("state", state);

        logger.info(`OAuth: Auto-login exitoso para "${companyName}" usando client_id como API key`);
        res.redirect(302, redirectUrl.toString());
        return;
      }
    } catch {
      // No era una API key válida, continuar con el formulario normal
    }
  }

  // Mostrar formulario de autenticación
  res.type("html").send(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>QualityControl</title>
  <link rel="icon" type="image/png" href="${FAVICON_DATA_URL}" />
  <link rel="shortcut icon" href="${FAVICON_DATA_URL}" />
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: linear-gradient(135deg, #f7d8db 0%, #f2b9bf 48%, #ea9aa2 100%); display: flex; justify-content: center; align-items: center; min-height: 100vh; }
    .card { background: #fff; border-radius: 16px; box-shadow: 0 8px 32px rgba(130,22,22,0.16); padding: 44px 40px; max-width: 420px; width: 100%; text-align: center; border-top: 4px solid #b40000; }
    .logo { margin-bottom: 22px; }
    .logo img { display: block; width: 100%; max-width: 160px; margin: 0 auto; height: auto; }
    p { color: #555; font-size: 0.9rem; margin-bottom: 24px; line-height: 1.5; text-align: left; }
    p strong { color: #7b0000; }
    label { display: block; font-weight: 600; color: #7b0000; margin-bottom: 6px; font-size: 0.9rem; text-align: left; }
    input[type=password] { width: 100%; padding: 14px; border: 2px solid #d0d5e0; border-radius: 8px; font-size: 1rem; margin-bottom: 20px; transition: border-color 0.2s, box-shadow 0.2s; }
    input[type=password]:focus { outline: none; border-color: #b40000; box-shadow: 0 0 0 3px rgba(180,0,0,0.12); }
    button { width: 100%; padding: 14px; background: #b40000; color: white; border: none; border-radius: 8px; font-size: 1rem; font-weight: 600; cursor: pointer; transition: background 0.2s; }
    button:hover { background: #8f0000; }
    .info { font-size: 0.8rem; color: #999; margin-top: 8px; text-align: center; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">
      <img src="${escapeHtml(OAUTH_LOGO_URL)}" alt="COGROWERS Calidad" />
    </div>
    <p>Ingresa tu API Key para conectar tu empresa.<br>La puedes obtener desde <strong>cogrowers.cl</strong> en la secci&oacute;n <strong>API</strong>.</p>
    <form method="POST" action="${escapeHtml(BASE_URL)}/authorize">
      <input type="hidden" name="client_id" value="${escapeHtml(client_id)}" />
      <input type="hidden" name="redirect_uri" value="${escapeHtml(redirect_uri)}" />
      <input type="hidden" name="state" value="${escapeHtml(state)}" />
      <input type="hidden" name="code_challenge" value="${escapeHtml(code_challenge)}" />
      <input type="hidden" name="code_challenge_method" value="${escapeHtml(code_challenge_method)}" />
      <input type="hidden" name="response_type" value="code" />
      <label for="api_key">API Key</label>
      <input type="password" id="api_key" name="api_key" placeholder="Pega tu API Key aquí" required />
      <button type="submit">Conectar empresa</button>
    </form>
    <p class="info">Tu API Key se almacena encriptada en el servidor y nunca se comparte con terceros.</p>
  </div>
</body>
</html>`);
});

// Authorization Endpoint â€” POST procesa el formulario
app.post("/authorize", async (req, res) => {
  const { client_id, redirect_uri, state, code_challenge, code_challenge_method, response_type, api_key } = req.body;

  if (response_type !== "code" || !api_key) {
    res.status(400).json({ error: "invalid_request" });
    return;
  }

  // Validar API Key contra la API configurada
  try {
    const validation = await apiClient.validateApiKey(api_key.trim());

    if (!validation.success) {
      logger.warn(`OAuth: API Key invÃ¡lida desde ${client_id}`);
      res.type("html").send(`<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Error</title>
<style>body{font-family:sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;background:#f0f4f0}.card{background:#fff;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,0.1);padding:40px;max-width:420px;text-align:center}h1{color:#991b1b;margin-bottom:12px}p{color:#666;margin-bottom:20px}a{color:#1a5d1a;font-weight:600}</style>
</head><body><div class="card"><h1>API Key invÃ¡lida</h1><p>La API Key ingresada no es vÃ¡lida o no tiene permisos. Verifica que la copiaste correctamente.</p><a href="javascript:history.back()">â† Volver a intentar</a></div></body></html>`);
      return;
    }

    // API Key vÃ¡lida â€” extraer info de empresa compatible con mÃºltiples formatos
    const normalized = validation as Record<string, unknown>;
    const devices = normalizeValidationItems(normalized);
    const companyName = extractCompanyName(normalized, devices);
    const deviceCount = extractDeviceCount(normalized, devices);

    // Generar cÃ³digo de autorizaciÃ³n con API Key incluida
    const code = randomUUID();
    authCodes.set(code, {
      clientId: client_id,
      redirectUri: redirect_uri,
      codeChallenge: code_challenge,
      codeChallengeMethod: code_challenge_method,
      expiresAt: Date.now() + 5 * 60 * 1000,
      apiKey: api_key.trim(),
      companyName,
      deviceCount,
    });

    const redirectUrl = new URL(redirect_uri);
    redirectUrl.searchParams.set("code", code);
    if (state) redirectUrl.searchParams.set("state", state);

    logger.info(`OAuth: Empresa "${companyName}" autorizada (${deviceCount} dispositivos)`);
    res.redirect(302, redirectUrl.toString());
  } catch (error) {
    logger.error("OAuth: Error validando API Key", { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ error: "server_error" });
  }
});

// Token Endpoint
app.post("/token", (req, res) => {
  const { grant_type, code, client_id, code_verifier } = req.body;

  if (grant_type !== "authorization_code") {
    res.status(400).json({ error: "unsupported_grant_type" });
    return;
  }

  const authCode = authCodes.get(code);
  if (!authCode || authCode.expiresAt < Date.now()) {
    authCodes.delete(code);
    res.status(400).json({ error: "invalid_grant" });
    return;
  }

  // Validate PKCE (RFC 7636) if code_challenge was stored
  if (authCode.codeChallenge) {
    if (!code_verifier) {
      res.status(400).json({ error: "invalid_grant", error_description: "code_verifier required" });
      return;
    }
    const method = authCode.codeChallengeMethod || "S256";
    let computedChallenge: string;
    if (method === "S256") {
      computedChallenge = createHash("sha256").update(code_verifier).digest("base64url");
    } else {
      computedChallenge = code_verifier;
    }
    if (computedChallenge !== authCode.codeChallenge) {
      authCodes.delete(code);
      res.status(400).json({ error: "invalid_grant", error_description: "PKCE verification failed" });
      return;
    }
  }

  // Eliminar código usado (single-use)
  authCodes.delete(code);

  // Generar access token (incluye API Key si fue proporcionada en authorize)
  const token = `mcp_${randomUUID()}`;
  accessTokens.set(token, {
    clientId: client_id || authCode.clientId,
    expiresAt: Date.now() + 10 * 365 * 24 * 60 * 60 * 1000, // 10 años — sin vencimiento práctico
    authVersion: getAuthVersion(),
    apiKey: authCode.apiKey,
    companyName: authCode.companyName,
    deviceCount: authCode.deviceCount,
  });

  // Persistir token en disco para que sobreviva reinicios del servidor
  saveTokens();

  logger.info(`OAuth: Token emitido para ${client_id || authCode.clientId}`);

  res.json({
    access_token: token,
    token_type: "Bearer",
    expires_in: 315360000, // 10 años en segundos
    scope: "mcp",
  });
});

// â”€â”€â”€ MCP Endpoint â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// Middleware: verificar Bearer token en /mcp.
// Devuelve tokenData si el token es válido, null si no (y ya envió 401).
function validateBearerToken(req: express.Request, res: express.Response): TokenData | null {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    logger.debug("validateBearerToken: No hay Authorization header");
    const resourceMetadataUrl = `${BASE_URL}/.well-known/oauth-protected-resource`;
    res.status(401)
      .set("WWW-Authenticate", `Bearer resource_metadata="${resourceMetadataUrl}"`)
      .json({ error: "unauthorized", error_description: "Bearer token required" });
    return null;
  }

  const token = authHeader.slice(7);
  const tokenData = accessTokens.get(token);
  const isRevoked = isTokenRevoked(token);
  const staleAuthVersion = tokenData ? tokenData.authVersion !== getAuthVersion() : false;

  if (!tokenData || tokenData.expiresAt < Date.now() || isRevoked || staleAuthVersion) {
    logger.info(`validateBearerToken: Token rechazado [exists=${!!tokenData}, expired=${tokenData ? tokenData.expiresAt < Date.now() : 'N/A'}, revoked=${isRevoked}, staleAuthVersion=${staleAuthVersion}]`);
    accessTokens.delete(token);
    clearRevoked(token);
    saveTokens();
    const resourceMetadataUrl = `${BASE_URL}/.well-known/oauth-protected-resource`;
    res.status(401)
      .set("WWW-Authenticate", `Bearer error="invalid_token", resource_metadata="${resourceMetadataUrl}"`)
      .json({ error: "invalid_token", error_description: "Token expired or invalid" });
    return null;
  }

  logger.debug(`validateBearerToken: OK [company=${tokenData.companyName ?? 'N/A'}]`);
  return tokenData;
}

app.all("/mcp", async (req, res) => {
  try {
    // Verificar autenticación — devuelve tokenData o null (ya envió 401)
    const tokenData = validateBearerToken(req, res);
    if (!tokenData) return;

    // Todas las operaciones siguientes corren dentro del contexto aislado de este token.
    // AsyncLocalStorage garantiza que getRequestApiKey() devuelva la key de ESTE usuario.
    await runWithApiKey(tokenData.apiKey ?? "", async () => {

    // Verificar si es una sesiÃ³n existente
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (sessionId && transports.has(sessionId)) {
      // SesiÃ³n existente: reutilizar transport
      const transport = transports.get(sessionId)!;
      await transport.handleRequest(req, res, req.body);
      return;
    }

    // Para GET/DELETE sin sesiÃ³n vÃ¡lida, rechazar
    if (req.method === "GET" || req.method === "DELETE") {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    // Nueva sesiÃ³n (POST con initialize): crear transport + servidor MCP
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });

    const server = createMcpServer();
    await server.connect(transport);

    // handleRequest procesa el initialize y GENERA el sessionId
    await transport.handleRequest(req, res, req.body);

    // Guardar DESPUÃ‰S de handleRequest (ahora sÃ­ tiene sessionId)
    if (transport.sessionId) {
      transports.set(transport.sessionId, transport);
      logger.info(`Nueva sesiÃ³n MCP: ${transport.sessionId}`);
    }

    // Auto-conectar empresa si el token tiene API Key (del formulario OAuth)
    const bearerToken = req.headers.authorization?.slice(7);
    if (bearerToken && tokenData.apiKey) {
      try {
        // Auto-conectar: buscar sesión existente para ESTE usuario (por hash de su API key)
        // No afecta ni comprueba sesiones de otros usuarios
        const existingSession = sessionManager.getSession();
        if (!existingSession) {
          sessionManager.connectCompany(
            tokenData.apiKey,
            tokenData.companyName ?? null,
            null,
            null,
            tokenData.deviceCount ?? 0
          );
        }
        // Asociar token con la sesión para poder revocarla desde disconnect
        const mySession = sessionManager.getSession();
        if (mySession) {
          associateToken(mySession.sessionId, bearerToken);
        }
        logger.info(`Auto-conectada empresa "${tokenData.companyName}" via OAuth`);
      } catch (err) {
        logger.warn("Error auto-conectando empresa", { error: err instanceof Error ? err.message : String(err) });
      }
    }

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) {
        transports.delete(sid);
        logger.info(`Sesión MCP cerrada: ${sid}`);
      }
    };

    }); // fin runWithApiKey
  } catch (error) {
    logger.error("Error en /mcp", {
      error: error instanceof Error ? error.message : String(error),
    });
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

// â”€â”€â”€ Logout Endpoint â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * POST /logout â€” Cierre de sesiÃ³n completo.
 * Revoca tokens, elimina sesiones, limpia cachÃ©.
 * Garantiza que la prÃ³xima conexiÃ³n requiera nueva API Key.
 */
app.post("/logout", async (req, res) => {
  const bearerToken = req.headers.authorization?.slice(7);
  const tokenData = bearerToken ? accessTokens.get(bearerToken) : undefined;

  logger.info("=== LOGOUT INICIADO ===");

  // 1. Revocar SOLO la sesión del usuario actual (no afecta a otros usuarios)
  let revokedSessions = 0;
  if (tokenData?.apiKey) {
    // runWithApiKey hace que disconnectCurrent() encuentre la sesión correcta por API key
    revokedSessions = await runWithApiKey(tokenData.apiKey, async () => {
      return sessionManager.disconnectCurrent() ? 1 : 0;
    });
  }
  logger.info(`Logout: ${revokedSessions} sesión(es) revocada(s) para este usuario`);

  // 2. Revocar SOLO el token OAuth actual (NO revokeAllTokens — no afectar otros usuarios)
  if (bearerToken) {
    accessTokens.delete(bearerToken);
    logger.info(`Logout: Token eliminado de accessTokens`);
  }

  // Persistir el estado actualizado
  saveTokens();

  // 3. Limpiar caché
  cacheManager.clear();
  logger.info("Logout: Caché limpiado");

  // 5. Respuesta con headers anti-cachÃ©
  res.set({
    "Clear-Site-Data": '"cache", "cookies", "storage"',
    "Cache-Control": "no-store, no-cache, must-revalidate",
    "Pragma": "no-cache",
  });

  res.json({
    logout_success: true,
    message: "SesiÃ³n cerrada completamente. Debe autenticarse nuevamente.",
    cleared: {
      sessions: revokedSessions,
      tokens: true,
      cache: true,
    },
  });

  logger.info("=== LOGOUT COMPLETADO ===");
});

// â”€â”€â”€ Health check â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "qualitycontrol-mcp",
    version: "1.0.0",
    transport: "streamable-http",
    activeSessions: transports.size,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// â”€â”€â”€ Iniciar servidor HTTP â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

app.listen(PORT, HOST, () => {
  logger.info(`QualityControl MCP Server v1.0.0 (HTTP) escuchando en http://${HOST}:${PORT}`);
  logger.info(`MCP endpoint: POST http://${HOST}:${PORT}/mcp`);
  logger.info(`Health check: GET http://${HOST}:${PORT}/health`);
  logger.info(`Tools registrados: ${tools.length}`);
});

// â”€â”€â”€ Graceful shutdown â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function shutdown(signal: string): Promise<void> {
  logger.info(`Recibido ${signal}, cerrando servidor...`);

  // Cerrar todas las sesiones activas
  for (const [sid, transport] of transports) {
    try {
      await transport.close();
      logger.debug(`SesiÃ³n ${sid} cerrada`);
    } catch {
      // ignore
    }
  }
  transports.clear();

  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

process.on("uncaughtException", (error) => {
  logger.error("ExcepciÃ³n no capturada", { error: error.message, stack: error.stack });
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  logger.error("Promesa rechazada no manejada", {
    reason: reason instanceof Error ? reason.message : String(reason),
  });
});
