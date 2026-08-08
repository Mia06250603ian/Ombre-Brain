#!/usr/bin/env python3
"""把 clawd-on-desk 的原始 GIF 转成 Telegram 视频贴纸(512x512 / VP9 / alpha / <=3s / <=256KB)。

和 2026-08-07 那一版的区别:先裁到内容包围盒再居中放大,不再把整幅 303x300 的桌宠画布
原样塞进 512(那正是空白的来源)。

⚠️ 解 GIF 必须用 PIL,不能用 ffmpeg:ffmpeg 对这批 GIF 的帧间 disposal 处理有误,
会在画面顶边留下上一帧的残片(木板/锤头),导致内容包围盒被撑成整幅画布、裁剪等于没做。
PIL 的 ImageSequence 结果与 08-07 上线那版的实测包围盒逐像素吻合。

用法: python3 build.py <输出目录> <普通18张的放大倍数> <mini6张的放大倍数>
"""
import subprocess, sys, os, glob
import numpy as np, imageio_ffmpeg
from PIL import Image, ImageSequence

FF = imageio_ffmpeg.get_ffmpeg_exe()
SRC = "/workspace/mia06250603ian/clawd-on-desk/assets/gif"
CANVAS = 512
OUT_FRAMES, OUT_FPS = 89, 30          # 2.967s,与 08-07 上线那版逐帧一致

# 影子清除(照 08-07 的两个安全阈值,按原尺寸折算:14/1.7≈8 行,40/1.7≈24 px)
SHADOW_ROWS, SHADOW_RUN = 8, 24
DARK = 70                              # max(r,g,b) < 70 算深色


def decode(path):
    im = Image.open(path)
    return np.stack([np.array(f.convert("RGBA")) for f in ImageSequence.Iterator(im)])


def strip_shadow(a):
    """逐帧:只在「该帧内容最底下 SHADOW_ROWS 行」里,把长度 > SHADOW_RUN 的深色横条抹成透明。"""
    W = a.shape[2]
    removed = 0
    for f in range(a.shape[0]):
        op = a[f, ..., 3] > 16
        ys = np.where(op.any(axis=1))[0]
        if ys.size == 0:
            continue
        for y in range(max(ys.max() - SHADOW_ROWS + 1, 0), ys.max() + 1):
            row = a[f, y]
            dark = (row[:, :3].max(axis=1) < DARK) & (row[:, 3] > 16)
            x = 0
            while x < W:
                if dark[x]:
                    x2 = x
                    while x2 < W and dark[x2]:
                        x2 += 1
                    if x2 - x > SHADOW_RUN:
                        a[f, y, x:x2, 3] = 0
                        removed += x2 - x
                    x = x2
                else:
                    x += 1
    return removed


def bleed(canv, iters=4):
    """把不透明像素的颜色向透明区外扩 iters 圈(alpha 一个字不动)。

    ⚠️ 这一步不能省。VP9 的 yuva420p 色度是 2x2 下采样的,螃蟹轮廓那一圈色度块里
    同时有螃蟹和背景,编出来解回 RGB 会在轮廓上渗出一圈**绿边**(实测每张三万个像素)。
    提高码率、甚至 -lossless 1 都消不掉(实测),yuva444p 也不是根治;把颜色外扩出去、
    让边缘色度块里全是螃蟹自己的颜色,绿边归零,而且体积不变。
    08-07 那版没有这个问题(实测线上文件绿像素 0),所以这是新管线必须自己补上的一环。
    """
    out = canv.copy()
    done = out[..., 3] > 16
    for _ in range(iters):
        rgb = out[..., :3].astype(np.int32)
        acc = np.zeros_like(rgb)
        cnt = np.zeros(done.shape, np.int32)
        for dy, dx in [(-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (-1, 1), (1, -1), (1, 1)]:
            acc += np.roll(rgb, (dy, dx), axis=(1, 2)) * np.roll(done, (dy, dx), axis=(1, 2))[..., None]
            cnt += np.roll(done, (dy, dx), axis=(1, 2))
        fill = (~done) & (cnt > 0)
        out[..., :3] = np.where(fill[..., None], acc // np.maximum(cnt, 1)[..., None], rgb).astype(np.uint8)
        done = done | fill
    return out


def union_bbox(a):
    m = (a[..., 3] > 16).any(axis=0)
    ys, xs = np.where(m)
    return xs.min(), xs.max(), ys.min(), ys.max()


def build(path, out, scale, shadow):
    a = decode(path)
    rm = strip_shadow(a) if shadow else 0
    x0, x1, y0, y1 = union_bbox(a)
    # 外扩在「原尺寸的裁剪块」上做,不在 512 画布上做:等价(放大是最近邻,外扩会一起放大),
    # 但快约三个数量级——在 512 画布上逐帧跑 24 张会跑掉十几分钟。
    crop = bleed(a[:, y0:y1 + 1, x0:x1 + 1, :])
    n, ch, cw = crop.shape[0], crop.shape[1], crop.shape[2]
    nw, nh = int(round(cw * scale)), int(round(ch * scale))
    assert nw <= CANVAS and nh <= CANVAS, f"{path} 放大后 {nw}x{nh} 超出画布"

    # 最近邻放大(像素画唯一能用的插值)+ 居中贴到 512 透明画布
    xi = (np.arange(nw) * cw // nw).clip(0, cw - 1)
    yi = (np.arange(nh) * ch // nh).clip(0, ch - 1)
    big = crop[:, yi][:, :, xi]
    ox, oy = (CANVAS - nw) // 2, (CANVAS - nh) // 2
    # ⚠️ 透明区的 RGB 必须是白色,不能留 0:VP9 编 yuva420p 时 alpha=0 那块的色度照样参与
    # 4:2:0 下采样,RGB=0 会在螃蟹边缘渗出一圈绿边(实测背景解出来是 (0,255,0,0))。
    # 白底与 GIF 原件、与 08-07 上线那版一致(线上版透明区实测就是 (255,255,255,0))。
    canvas = np.full((OUT_FRAMES, CANVAS, CANVAS, 4), 255, np.uint8)
    canvas[..., 3] = 0
    idx = (np.arange(OUT_FRAMES) * n // OUT_FRAMES).clip(0, n - 1)   # 时间轴归一到 2.967s
    canvas[:, oy:oy + nh, ox:ox + nw, :] = big[idx]

    p = subprocess.Popen(
        [FF, "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgba",
         "-s", f"{CANVAS}x{CANVAS}", "-framerate", str(OUT_FPS), "-i", "-",
         "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-auto-alt-ref", "0",
         "-b:v", "0", "-crf", "32", "-an", out], stdin=subprocess.PIPE)
    p.communicate(canvas.tobytes())
    assert p.returncode == 0, f"编码失败 {out}"
    return dict(file=os.path.basename(out), src=(int(cw), int(ch)), placed=(nw, nh),
                margin_pct=round(min(ox, oy) / CANVAS * 100, 1),
                shadow_px=rm, kb=round(os.path.getsize(out) / 1024, 1))


if __name__ == "__main__":
    outdir, s18, smini = sys.argv[1], float(sys.argv[2]), float(sys.argv[3])
    os.makedirs(outdir, exist_ok=True)
    rows = []
    for g in sorted(glob.glob(f"{SRC}/clawd-*.gif")):
        mini = "-mini-" in g
        name = os.path.basename(g).replace(".gif", ".webm")
        rows.append(build(g, os.path.join(outdir, name), smini if mini else s18, not mini))
    print(f"{'file':32s}{'包围盒':>12s}{'放到':>12s}{'留边':>7s}{'抹影子px':>9s}{'KB':>8s}")
    for r in rows:
        print(f"{r['file']:32s}{str(r['src']):>12s}{str(r['placed']):>12s}"
              f"{r['margin_pct']:6.1f}%{r['shadow_px']:9d}{r['kb']:8.1f}")
    print("最大体积", max(r['kb'] for r in rows), "KB;超 256KB 的:",
          [r['file'] for r in rows if r['kb'] > 256] or "无")
