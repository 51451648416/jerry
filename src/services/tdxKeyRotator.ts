/**
 * TDX API Key Rotation & Failover System (精要輪流金鑰管理器)
 *
 * 核心機制：
 * 1. 支援多組 TDX Client ID 與 Client Secret (可由環境變數、配置陣列或動態擴充設定)。
 * 2. 輪流調度機制 (Round-Robin with Automatic Failover)：
 *    - 平時使用當前有效的金鑰組 (Active Key)。
 *    - 當第一組金鑰失效、達到請求頻率上限 (429/401/403/逾期) 或連線失敗時，自動輪轉切換至第二組金鑰。
 *    - 若後續組別失效，則依序推進並自動「輪轉循環 (Loop Back)」回第一組，確保服務永不中斷。
 * 3. 獨立封裝，絕不干涉或變更任何交通流物理估計、微元動態積分與既有數學運算公式。
 */

export interface TdxKeyPair {
  id: string;
  clientId: string;
  clientSecret: string;
  label: string;
  failCount: number;
  lastUsedTimestamp?: number;
  lastError?: string;
  isHealthy: boolean;
}

export interface CachedTokenEntry {
  accessToken: string;
  expiresAt: number;
  keyId: string;
}

export interface TdxKeyManagerStatus {
  totalKeys: number;
  activeKeyIndex: number;
  activeKeyLabel: string;
  activeClientIdMasked: string;
  rotationCount: number;
  lastRotationTimestamp?: string;
  lastRotationReason?: string;
  keysStatus: {
    index: number;
    label: string;
    clientIdMasked: string;
    isHealthy: boolean;
    failCount: number;
    lastError?: string;
  }[];
}

export class TdxKeyRotationSystem {
  private keyPairs: TdxKeyPair[] = [];
  private activeIndex: number = 0;
  private tokenCache: Map<string, CachedTokenEntry> = new Map();
  private rotationCount: number = 0;
  private lastRotationTimestamp?: string;
  private lastRotationReason?: string;

  constructor() {
    this.initializeKeys();
  }

  /**
   * 初始化金鑰池
   * 優先讀取環境變數 (TDX_CLIENT_ID / TDX_CLIENT_SECRET, TDX_CLIENT_ID_2 / TDX_CLIENT_SECRET_2 等)
   */
  private initializeKeys() {
    const defaultKeys: { id: string; clientId: string; clientSecret: string; label: string }[] = [];

    // 主要金鑰 (Primary Group 1)
    const id1 = process.env.TDX_CLIENT_ID || "jerry09032-f563b9b2-6af4-4437";
    const secret1 = process.env.TDX_CLIENT_SECRET || "0b749325-d88e-4e11-9d4d-318cb6f34fbe";
    if (id1 && secret1) {
      defaultKeys.push({
        id: "key-group-1",
        clientId: id1,
        clientSecret: secret1,
        label: "TDX 金鑰組 1 (主要通道)",
      });
    }

    // 備用金鑰組 2 (由環境變數 TDX_CLIENT_ID_2 注入)
    const id2 = process.env.TDX_CLIENT_ID_2;
    const secret2 = process.env.TDX_CLIENT_SECRET_2;
    if (id2 && secret2) {
      defaultKeys.push({
        id: "key-group-2",
        clientId: id2,
        clientSecret: secret2,
        label: "TDX 金鑰組 2 (備用通道 A)",
      });
    }

    // 備用金鑰組 3 (由環境變數 TDX_CLIENT_ID_3 注入)
    const id3 = process.env.TDX_CLIENT_ID_3;
    const secret3 = process.env.TDX_CLIENT_SECRET_3;
    if (id3 && secret3) {
      defaultKeys.push({
        id: "key-group-3",
        clientId: id3,
        clientSecret: secret3,
        label: "TDX 金鑰組 3 (備用通道 B)",
      });
    }

    // 支援以 JSON 陣列或自訂字串擴充 (TDX_API_KEYS: '[{"id":"...","secret":"..."}]' 或 'id:secret,id2:secret2')
    if (process.env.TDX_API_KEYS) {
      try {
        const parsed = JSON.parse(process.env.TDX_API_KEYS);
        if (Array.isArray(parsed)) {
          parsed.forEach((item: any, idx: number) => {
            if (item.clientId && item.clientSecret) {
              defaultKeys.push({
                id: `key-custom-${idx + 1}`,
                clientId: item.clientId,
                clientSecret: item.clientSecret,
                label: item.label || `TDX 自訂金鑰組 ${idx + 1}`,
              });
            }
          });
        }
      } catch (e) {
        // 若為逗號分隔格式 id:secret,id2:secret2
        const rawPairs = process.env.TDX_API_KEYS.split(",");
        rawPairs.forEach((pair, idx) => {
          const [cid, csec] = pair.split(":");
          if (cid && csec && cid.trim() && csec.trim()) {
            defaultKeys.push({
              id: `key-env-pair-${idx + 1}`,
              clientId: cid.trim(),
              clientSecret: csec.trim(),
              label: `TDX 環境金鑰組 ${idx + 1}`,
            });
          }
        });
      }
    }

    this.keyPairs = defaultKeys.map((k) => ({
      id: k.id,
      clientId: k.clientId,
      clientSecret: k.clientSecret,
      label: k.label,
      failCount: 0,
      isHealthy: true,
    }));

    if (this.keyPairs.length === 0) {
      // 確保至少有一組預設鍵
      this.keyPairs.push({
        id: "key-default",
        clientId: "jerry09032-f563b9b2-6af4-4437",
        clientSecret: "0b749325-d88e-4e11-9d4d-318cb6f34fbe",
        label: "TDX 預設金鑰組",
        failCount: 0,
        isHealthy: true,
      });
    }
  }

  /**
   * 取得當前輪值中的金鑰
   */
  public getActiveKeyPair(): TdxKeyPair {
    if (this.keyPairs.length === 0) {
      this.initializeKeys();
    }
    return this.keyPairs[this.activeIndex % this.keyPairs.length];
  }

  /**
   * 將金鑰遮罩化 (保證 API Key 安全性)
   */
  private maskString(str: string): string {
    if (!str || str.length <= 8) return "********";
    return `${str.substring(0, 4)}...${str.substring(str.length - 4)}`;
  }

  /**
   * 切換並輪轉至下一組金鑰 (Round-Robin Failover Loop)
   * 依序：第1組 -> 第2組 -> 第3組 -> ... -> 輪回到第1組
   */
  public rotateToNextKey(reason: string = "連線或授權異常自動輪替"): TdxKeyPair {
    const prevIndex = this.activeIndex;
    const currentKey = this.keyPairs[prevIndex];
    currentKey.failCount += 1;
    currentKey.lastError = reason;

    // 若單一金鑰連續失敗 >= 3 次，暫時標記為異常
    if (currentKey.failCount >= 3) {
      currentKey.isHealthy = false;
    }

    // 核心循環輪轉公式：(currentIndex + 1) % keyPairs.length
    this.activeIndex = (this.activeIndex + 1) % this.keyPairs.length;
    this.rotationCount += 1;
    this.lastRotationTimestamp = new Date().toISOString();
    this.lastRotationReason = reason;

    const nextKey = this.keyPairs[this.activeIndex];

    console.warn(
      `[TDX 金鑰輪流系統] 金鑰組切換 #${this.rotationCount}：從「${currentKey.label}」(${this.maskString(
        currentKey.clientId
      )}) 輪轉切換至「${nextKey.label}」(${this.maskString(nextKey.clientId)})。原因：${reason}`
    );

    return nextKey;
  }

  /**
   * 請求指定金鑰組的 TDX Access Token
   */
  private async requestTokenForPair(pair: TdxKeyPair): Promise<string> {
    const cached = this.tokenCache.get(pair.id);
    if (cached && cached.expiresAt > Date.now() + 60000) {
      return cached.accessToken;
    }

    const authUrl = "https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token";
    const requestBody = `grant_type=client_credentials&client_id=${encodeURIComponent(
      pair.clientId
    )}&client_secret=${encodeURIComponent(pair.clientSecret)}`;

    const response = await fetch(authUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: requestBody,
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`TDX 認證伺服器回應失敗 (${response.status}): ${errText}`);
    }

    const data = await response.json();
    if (!data.access_token) {
      throw new Error("TDX 未回傳有效的 access_token");
    }

    const expiresInSec = data.expires_in || 86400;
    this.tokenCache.set(pair.id, {
      accessToken: data.access_token,
      expiresAt: Date.now() + expiresInSec * 1000,
      keyId: pair.id,
    });

    pair.isHealthy = true;
    pair.failCount = 0;
    pair.lastUsedTimestamp = Date.now();

    return data.access_token;
  }

  /**
   * 取得有效的 Access Token (具備多組金鑰自動輪轉與重試保障)
   */
  public async getValidAccessToken(): Promise<{ token: string; keyPair: TdxKeyPair }> {
    const maxAttempts = this.keyPairs.length;
    let lastError: any = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const currentPair = this.getActiveKeyPair();
      try {
        const token = await this.requestTokenForPair(currentPair);
        return { token, keyPair: currentPair };
      } catch (err: any) {
        lastError = err;
        console.error(`[TDX 金鑰輪流系統] 金鑰組「${currentPair.label}」獲取 Token 失敗：`, err.message);
        // 輪轉到下一組金鑰並重試
        this.rotateToNextKey(`Token 請求異常 (${err.message})`);
      }
    }

    throw new Error(
      `所有 TDX 金鑰組皆無法成功連線獲取 Token (共輪轉嘗試 ${maxAttempts} 組)。最後錯誤：${lastError?.message || "未知錯誤"}`
    );
  }

  /**
   * 執行帶有金鑰自動輪轉與失效切換保護的 TDX API 請求 (Failover Round-Robin Execution)
   */
  public async executeWithFailover<T>(
    endpointUrl: string,
    options: {
      method?: string;
      headers?: Record<string, string>;
      body?: any;
    } = {}
  ): Promise<{ data: T; usedKeyPair: TdxKeyPair; attempts: number }> {
    const maxAttempts = this.keyPairs.length;
    let lastError: any = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const currentPair = this.getActiveKeyPair();
      try {
        const { token } = await this.getValidAccessToken();

        const reqHeaders = {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(options.headers || {}),
        };

        const res = await fetch(endpointUrl, {
          method: options.method || "GET",
          headers: reqHeaders,
          body: options.body,
        });

        // 檢查是否遭遇授權失效或限流 (401 Unauthorized / 403 Forbidden / 429 Too Many Requests)
        if (res.status === 401 || res.status === 403 || res.status === 429) {
          const errText = await res.text();
          console.warn(
            `[TDX 金鑰輪流系統] 金鑰「${currentPair.label}」遭遇 HTTP ${res.status}，自動切換至下一組金鑰...`
          );
          // 清除該金鑰的 token 快取
          this.tokenCache.delete(currentPair.id);
          this.rotateToNextKey(`遭遇 HTTP ${res.status}: ${errText}`);
          continue;
        }

        if (!res.ok) {
          const errText = await res.text();
          throw new Error(`TDX 數據端點回應錯誤 (${res.status}): ${errText}`);
        }

        const data = (await res.json()) as T;
        currentPair.lastUsedTimestamp = Date.now();
        currentPair.isHealthy = true;

        return {
          data,
          usedKeyPair: currentPair,
          attempts: attempt + 1,
        };
      } catch (err: any) {
        lastError = err;
        console.error(`[TDX 金鑰輪流系統] 透過「${currentPair.label}」請求數據失敗：`, err.message);
        this.rotateToNextKey(`API 請求異常: ${err.message}`);
      }
    }

    throw new Error(
      `所有 TDX 金鑰輪替嘗試皆失敗 (共測試 ${maxAttempts} 組金鑰)。最後異常：${lastError?.message || "連線逾時"}`
    );
  }

  /**
   * 取得當前輪流系統診斷與健康狀態 (遮罩敏感密鑰)
   */
  public getStatus(): TdxKeyManagerStatus {
    const activeKey = this.getActiveKeyPair();
    return {
      totalKeys: this.keyPairs.length,
      activeKeyIndex: this.activeIndex,
      activeKeyLabel: activeKey.label,
      activeClientIdMasked: this.maskString(activeKey.clientId),
      rotationCount: this.rotationCount,
      lastRotationTimestamp: this.lastRotationTimestamp,
      lastRotationReason: this.lastRotationReason,
      keysStatus: this.keyPairs.map((k, idx) => ({
        index: idx,
        label: k.label,
        clientIdMasked: this.maskString(k.clientId),
        isHealthy: k.isHealthy,
        failCount: k.failCount,
        lastError: k.lastError,
      })),
    };
  }
}

// 導出全域單例模式管理器 (Singleton Instance)
export const globalTdxKeyManager = new TdxKeyRotationSystem();
