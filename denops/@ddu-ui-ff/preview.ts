import {
  ActionFlags,
  BufferPreviewer,
  Context,
  DduItem,
  DduOptions,
  NoFilePreviewer,
  Previewer,
  TermPreviewer,
} from "../../../ddu.vim/denops/ddu/types.ts";
import { batch, Denops, fn } from "https://deno.land/x/ddu_vim@v1.5.0/deps.ts";
import { ActionData } from "https://deno.land/x/ddu_kind_file@v0.3.0/file.ts";
import { replace } from "https://deno.land/x/denops_std@v3.3.0/buffer/mod.ts";
import { Params } from "../@ddu-uis/ff.ts";

export class PreviewUi {
  private previewWinId = -1;
  private terminalBufnr = -1;
  private previewedTarget: ActionData = {};
  private matchIds: Record<number, number> = {};
  private previewBufnrs: Set<number> = new Set();

  async close(denops: Denops) {
    if (this.previewWinId > 0) {
      const saveId = await fn.win_getid(denops);
      await batch(denops, async (denops) => {
        await fn.win_gotoid(denops, this.previewWinId);
        await denops.cmd("close!");
        await fn.win_gotoid(denops, saveId);
      });
      this.previewWinId = -1;
    }
    await batch(denops, async (denops) => {
      for (const bufnr of this.previewBufnrs) {
        await denops.cmd(`if buflisted(${bufnr}) | bdelete! ${bufnr} | endif`);
      }
    });
  }

  async preview(
    denops: Denops,
    _context: Context,
    options: DduOptions,
    uiParams: Params,
    actionParams: unknown,
    item: DduItem,
  ): Promise<ActionFlags> {
    const action = item.action as ActionData;
    const prevId = await fn.win_getid(denops);

    // close if the target is the same as the previous one
    if (
      this.previewWinId > 0 &&
      JSON.stringify(action) == JSON.stringify(this.previewedTarget)
    ) {
      await this.close(denops);
      return Promise.resolve(ActionFlags.None);
    }

    const previewer = await denops.dispatch(
      "ddu",
      "getPreviewer",
      options.name,
      item,
      actionParams,
    ) as Previewer;

    if (!previewer) {
      return Promise.resolve(ActionFlags.None);
    }

    let flag: ActionFlags;
    // render preview
    if (previewer.kind == "terminal") {
      flag = await this.previewTerminal(denops, previewer, uiParams);
    } else {
      flag = await this.previewBuffer(denops, previewer, uiParams, item);
    }
    if (flag == ActionFlags.None) {
      return flag;
    }

    await this.jump(denops, previewer);

    const bufnr = await fn.bufnr(denops);
    this.previewBufnrs.add(bufnr);
    this.previewedTarget = action;
    await fn.win_gotoid(denops, prevId);

    return Promise.resolve(ActionFlags.Persist);
  }

  private async previewTerminal(
    denops: Denops,
    previewer: TermPreviewer,
    uiParams: Params,
  ): Promise<ActionFlags> {
    if (this.previewWinId < 0) {
      await denops.call(
        "ddu#ui#ff#_preview_file",
        uiParams,
        "",
      );
      this.previewWinId = await fn.win_getid(denops) as number;
    } else {
      await batch(denops, async (denops: Denops) => {
        await fn.win_gotoid(denops, this.previewWinId);
        await denops.cmd("enew");
      });
    }
    if (denops.meta.host == "nvim") {
      await denops.call("termopen", previewer.cmds);
    } else {
      await denops.call("term_start", previewer.cmds, {
        "curwin": true,
        "term_kill": "kill",
      });
    }
    // delete previous buffer after opening new one to prevent flicker
    if (
      this.terminalBufnr > 0 &&
      (await fn.bufexists(denops, this.terminalBufnr))
    ) {
      try {
        await denops.cmd(`bdelete! ${this.terminalBufnr}`);
        this.terminalBufnr = -1;
      } catch (e) {
        console.error(e);
      }
    }
    return ActionFlags.Persist;
  }

  private async previewBuffer(
    denops: Denops,
    previewer: BufferPreviewer | NoFilePreviewer,
    uiParams: Params,
    item: DduItem,
  ): Promise<ActionFlags> {
    if (
      previewer.kind == "nofile" && !previewer.contents?.length ||
      previewer.kind == "buffer" && !previewer.expr && !previewer.path
    ) {
      return Promise.resolve(ActionFlags.None);
    }
    const bufname = await this.getPreviewBufferName(denops, previewer, item);
    const exists = await fn.buflisted(denops, bufname);
    if (this.previewWinId < 0) {
      await denops.call(
        "ddu#ui#ff#_preview_file",
        uiParams,
        "",
      );
      this.previewWinId = await fn.win_getid(denops) as number;
    } else {
      await fn.win_gotoid(denops, this.previewWinId);
    }
    if (!exists) {
      await denops.cmd(`edit ${bufname}`);
      const text = await this.getPreviewContents(denops, previewer);
    const bufnr = await fn.bufnr(denops) as number;
      await batch(denops, async (denops: Denops) => {
        await fn.setbufvar(denops, bufnr, "&buftype", "nofile");
        await replace(denops, bufnr, text);
        if (previewer.syntax) {
          await denops.cmd(`syntax ${previewer.syntax}`);
        } else if (previewer.kind == "buffer") {
          await denops.cmd("filetype detect");
        }
      });
    } else {
      await denops.cmd(`buffer ${bufname}`);
    }
    const bufnr = await fn.bufnr(denops) as number;
    await this.highlight(denops, previewer, bufnr);
    return ActionFlags.Persist;
  }

  private async getPreviewBufferName(
    denops: Denops,
    previewer: BufferPreviewer | NoFilePreviewer,
    item: DduItem,
  ): Promise<string> {
    if (previewer.kind == "buffer") {
      return `ddu-ff:${
        previewer.expr
          ? await fn.bufname(
            denops,
            previewer.expr,
          )
          : previewer.path
      }`;
    } else {
      return `ddu-ff:${item.word}`;
    }
  }

  private async getPreviewContents(
    denops: Denops,
    previewer: BufferPreviewer | NoFilePreviewer,
  ): Promise<string[]> {
    if (previewer.kind == "buffer") {
      if (previewer.expr && await fn.buflisted(denops, previewer.expr)) {
        return await fn.getbufline(
          denops,
          await fn.bufnr(denops, previewer.expr),
          1,
          "$",
        );
      } else if (previewer.path) {
        const data = Deno.readFileSync(previewer.path);
        return new TextDecoder().decode(data).split("\n");
      } else {
        return [];
      }
    } else {
      return previewer.contents;
    }
  }

  private async jump(denops: Denops, previewer: Previewer) {
    await batch(denops, async (denops: Denops) => {
      if (previewer && "lineNr" in previewer && previewer.lineNr) {
        await fn.cursor(denops, [previewer.lineNr, 0]);
        await denops.cmd("normal! zv");
        await denops.cmd("normal! zz");
      }
    });
  }

  private async highlight(
    denops: Denops,
    previewer: BufferPreviewer | NoFilePreviewer,
    bufnr: number,
  ) {
    const ns = denops.meta.host == "nvim"
      ? await denops.call("nvim_create_namespace", "ddu-ui-ff-preview")
      : 0;
    const winid = this.previewWinId;

    // clear previous highlight
    if (this.matchIds[winid] > 0) {
      await fn.matchdelete(denops, this.matchIds[winid], winid);
    }
    if (denops.meta.host == "nvim") {
      await denops.call("nvim_buf_clear_namespace", 0, ns, 0, -1);
    } else {
      await denops.call(
        "prop_clear",
        1,
        await fn.line(denops, "$", winid),
        0,
        -1,
      );
    }

    if (previewer && "lineNr" in previewer && previewer.lineNr) {
      this.matchIds[winid] = await fn.matchaddpos(denops, "Search", [
        previewer.lineNr,
      ]) as number;
    }
    await batch(denops, async (denops) => {
      if (previewer.highlights) {
        for (const hl of previewer.highlights) {
          await denops.call(
            "ddu#ui#ff#_highlight",
            hl.hl_group,
            hl.name,
            1,
            ns,
            bufnr,
            hl.row,
            hl.col,
            hl.width,
          );
        }
      }
    });
  }
}
