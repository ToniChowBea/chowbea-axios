/**
 * QuitDialog — confirmation overlay before exiting the app.
 * Press q or Enter to confirm, Escape to cancel.
 */

import { useKeyboard } from "@opentui/react";
import { colors } from "../theme/colors.js";

interface QuitDialogProps {
	onConfirm: () => void;
	onCancel: () => void;
}

export function QuitDialog({ onConfirm, onCancel }: QuitDialogProps) {
	useKeyboard((key) => {
		if (key.name === "q" || key.name === "return") {
			onConfirm();
			return;
		}
		if (key.name === "escape") {
			onCancel();
			return;
		}
	});

	return (
		<box
			flexDirection="column"
			flexGrow={1}
			justifyContent="center"
			alignItems="center"
		>
			<box
				flexDirection="column"
				width={40}
				border
				borderColor={colors.warning}
				backgroundColor={colors.bgSurface}
				padding={1}
				gap={1}
			>
				<text fg={colors.fgBright}>Quit chowbea?</text>
				<text fg={colors.fgDim}>
					All running processes will be stopped.
				</text>
				<box flexDirection="row" gap={3}>
					<text fg={colors.warning}>q / Enter</text>
					<text fg={colors.fg}>Quit</text>
				</box>
				<box flexDirection="row" gap={3}>
					<text fg={colors.fgDim}>Esc</text>
					<text fg={colors.fg}>Cancel</text>
				</box>
			</box>
		</box>
	);
}
