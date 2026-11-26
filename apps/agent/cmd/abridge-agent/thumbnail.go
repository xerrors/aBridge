package main

import (
	"bytes"
	"encoding/base64"
	"image"
	"image/color"
	"image/jpeg"
	_ "image/png"

	"github.com/xerrors/aBridge/apps/agent/internal/mcp"
)

// Receipt images are best effort, separate from the original model observation.
// Bound both compressed input and decoded allocation before decoding pixels.
const (
	thumbnailMaxInputBytes = 12 << 20
	thumbnailMaxPixels     = 16 << 20
	thumbnailMaxDimension  = 8192
	thumbnailSide          = 960
	thumbnailMaxDataURL    = 750000
)

func taskThumbnail(images []mcp.Image) string {
	// The event contract has one image; use the first observation image.
	if len(images) == 0 {
		return ""
	}
	source := images[0]
	if source.MIMEType != "image/png" && source.MIMEType != "image/jpeg" {
		return ""
	}
	if len(source.Data) > base64.StdEncoding.EncodedLen(thumbnailMaxInputBytes) {
		return ""
	}
	data, err := base64.StdEncoding.DecodeString(source.Data)
	if err != nil || len(data) > thumbnailMaxInputBytes {
		return ""
	}
	config, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || config.Width <= 0 || config.Height <= 0 || config.Width > thumbnailMaxDimension || config.Height > thumbnailMaxDimension || config.Width > thumbnailMaxPixels/config.Height {
		return ""
	}
	img, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return ""
	}
	w, h := config.Width, config.Height
	if w > thumbnailSide || h > thumbnailSide {
		if w >= h {
			h = max(1, h*thumbnailSide/w)
			w = thumbnailSide
		} else {
			w = max(1, w*thumbnailSide/h)
			h = thumbnailSide
		}
	}
	thumb := image.NewRGBA(image.Rect(0, 0, w, h))
	bounds := img.Bounds()
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			// Nearest-neighbor sampling keeps work bounded by the thumbnail size.
			r, g, b, a := img.At(bounds.Min.X+x*config.Width/w, bounds.Min.Y+y*config.Height/h).RGBA()
			// Composite transparency onto white before JPEG encoding.
			thumb.SetRGBA(x, y, color.RGBA{uint8((r + 65535 - a) >> 8), uint8((g + 65535 - a) >> 8), uint8((b + 65535 - a) >> 8), 255})
		}
	}
	var encoded bytes.Buffer
	if jpeg.Encode(&encoded, thumb, &jpeg.Options{Quality: 65}) != nil {
		return ""
	}
	const prefix = "data:image/jpeg;base64,"
	if len(prefix)+base64.StdEncoding.EncodedLen(encoded.Len()) > thumbnailMaxDataURL {
		return ""
	}
	return prefix + base64.StdEncoding.EncodeToString(encoded.Bytes())
}
