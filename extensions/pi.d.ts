/**
 * 本地类型声明：仅用于仓库内 LSP 检查。
 *
 * 运行时由 pi 提供真实的 @earendil-works/pi-coding-agent 模块（pi 核心包），
 * 不在本仓库安装；本文件声明本扩展用到的接口子集。
 */
declare module "@earendil-works/pi-coding-agent" {
	export type ExtensionCommandHandler = (
		args: string | undefined,
		ctx: unknown,
	) => void | Promise<void>;

	export interface ExtensionAPI {
		registerCommand(
			name: string,
			options: {
				description: string;
				handler: ExtensionCommandHandler;
			},
		): void;
		sendUserMessage(
			message: string,
			options?: { deliverAs?: "steer" | "followUp" },
		): Promise<void>;
	}
}
