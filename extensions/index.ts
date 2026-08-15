import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * oh-story：`/story` 命令别名扩展。
 *
 * pi 原生用 `/skill:story` 加载 skill；本扩展注册 `/story` 命令，转发为
 * skill 命令的 followUp 消息，保持旧 CLI 用户的手感（`/story dashboard` 打开工作台）。
 * skill 本体与子代理部署见 story-setup。
 */
export default function (pi: ExtensionAPI) {
	pi.registerCommand("story", {
		description:
			"网文工具箱入口：/story 打开路由（自动分发到扫榜/拆文/写作等 skill），/story dashboard 打开本地写作工作台",
		handler: async (args, _ctx) => {
			const trimmed = (args ?? "").trim();
			const target = trimmed ? `/skill:story ${trimmed}` : "/skill:story";
			await pi.sendUserMessage(target, { deliverAs: "followUp" });
		},
	});
}
