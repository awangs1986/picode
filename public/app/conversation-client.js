export class ConversationClient {
  constructor(transport, wsClient, { heartbeatMs = 5000 } = {}) {
    this.transport = transport;
    this.wsClient = wsClient;
    this.heartbeatMs = Math.max(1000, heartbeatMs);
    this.current = null;
    this.heartbeat = null;
    this.onRoutingChanged = (event) => {
      const chatId = event?.detail?.sessionId || null;
      const operation = chatId ? this.ensureControl(chatId) : this.release();
      operation.catch(() => {});
    };
    this.wsClient.addEventListener?.("routingChanged", this.onRoutingChanged);
  }

  async ensureControl(chatId) {
    if (!chatId) return { granted: true, generation: null, unbound: true };
    if (this.current?.chatId === chatId) {
      return { granted: true, generation: this.current.generation };
    }
    if (this.current) await this.release();
    let claim = await this.transport.claimConversation(chatId);
    let control = claim?.control || null;
    if (claim?.decision === "observing" && control?.state === "suspect") {
      const deadline = Number(control?.controller?.challengeDeadline || 0);
      const delay = Math.max(0, Math.min(10_000, deadline - Date.now()));
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      try {
        await this.transport.reportFailedConversationProbe(chatId);
        claim = await this.transport.claimConversation(chatId);
        control = claim?.control || null;
      } catch {
        // The prior controller renewed during the challenge window. Preserve
        // observer mode; the user's draft remains local.
      }
    }
    if (claim?.decision !== "granted" || !control?.controller?.generation) {
      return {
        granted: false,
        state: control?.state || "unknown",
        controller: control?.controller || null,
      };
    }
    this.current = {
      chatId,
      generation: control.controller.generation,
    };
    this.wsClient.setConversationControl(this.current);
    this.startHeartbeat();
    return { granted: true, generation: this.current.generation };
  }

  async renew() {
    if (!this.current) return null;
    return this.transport.renewConversation(this.current.chatId, this.current.generation);
  }

  async authorizeMutation(chatId, mutationRequestId) {
    const control = await this.ensureControl(chatId);
    if (!control.granted || !control.generation) return control;
    await this.transport.authorizeConversation(chatId, control.generation, mutationRequestId);
    return control;
  }

  async release() {
    const current = this.current;
    this.current = null;
    this.stopHeartbeat();
    this.wsClient.setConversationControl(null);
    if (!current) return null;
    return this.transport.releaseConversation(current.chatId, current.generation);
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => {
      this.renew().catch(() => {
        this.current = null;
        this.wsClient.setConversationControl(null);
        this.stopHeartbeat();
      });
    }, this.heartbeatMs);
  }

  stopHeartbeat() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  stop() {
    this.stopHeartbeat();
    this.wsClient.removeEventListener?.("routingChanged", this.onRoutingChanged);
  }
}
