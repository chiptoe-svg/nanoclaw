---
name: image-gen
description: Generate images using OpenAI's image generation API (gpt-image-1 or dall-e-3). Use whenever the user asks you to create, draw, design, or generate an image. After generating, send the image to the chat with the send_photo MCP tool.
allowed-tools: Bash(image-gen:*)
---

# Image Generator

Generate images via OpenAI's API and save them locally.

## Quick start

```bash
image-gen "a cat sitting on a rainbow"                          # Default: gpt-image-1, 1024x1024
image-gen "a cat sitting on a rainbow" --model dall-e-3         # Use DALL-E 3
image-gen "futuristic city skyline" --size 1536x1024            # Wide landscape
image-gen "app icon design" --size 1024x1024 --quality high     # High quality
```

## Usage

```
image-gen <prompt> [options]
```

### Options

| Flag | Values | Default | Notes |
|------|--------|---------|-------|
| `--model` | `gpt-image-1`, `dall-e-3` | `gpt-image-1` | gpt-image-1 is newer and more capable |
| `--size` | `1024x1024`, `1536x1024`, `1024x1536` | `1024x1024` | dall-e-3 also supports `1792x1024`, `1024x1792` |
| `--quality` | `low`, `medium`, `high` (gpt-image-1) or `standard`, `hd` (dall-e-3) | `medium` / `standard` | Higher quality = slower + more expensive |
| `--output` | filename | auto-generated | Output path for the image |

### Output

Prints the path to the saved image file. Use this path with the `send_photo` MCP tool to send it to the chat.

## Workflow

1. Generate the image:
   ```bash
   image-gen "a watercolor painting of mountains at sunset"
   ```
2. Send it to the user with the `send_photo` tool using the output path.

## Model comparison

- **gpt-image-1**: Latest model. Better prompt adherence, more photorealistic, supports text rendering in images. Slightly more expensive.
- **dall-e-3**: Previous generation. Still good for creative/artistic styles. Supports `1792x` sizes.

## Examples

```bash
# Photorealistic
image-gen "professional headshot photo, studio lighting, neutral background"

# Creative / artistic
image-gen "impressionist painting of a rainy Paris street" --model dall-e-3

# Logo / icon design
image-gen "minimal flat logo for a coffee shop called Bean There" --quality high

# Wide format for presentations
image-gen "infographic-style diagram of the solar system" --size 1536x1024
```
