// Package expr compiles CEL expressions and dot paths used by pipelines.
package expr

import (
	"fmt"
	"strconv"
	"strings"
	"sync"

	"cel.dev/cel-go/cel"
	"cel.dev/cel-go/common/types"
	"cel.dev/cel-go/common/types/ref"
	"cel.dev/cel-go/common/types/traits"
	"cel.dev/cel-go/ext"
)

var (
	envOnce sync.Once
	env     *cel.Env
	envErr  error
)

func celEnv() (*cel.Env, error) {
	envOnce.Do(func() {
		env, envErr = cel.NewEnv(
			cel.Variable("o", cel.DynType),
			ext.Strings(),
			ext.Lists(),
			ext.Math(),
			cel.OptionalTypes(),
			sumLib(),
		)
	})
	return env, envErr
}

// costLimit bounds one evaluation (same order as the Kubernetes per-call
// limit), so a pathological filter can't stall a pane.
const costLimit = 1_000_000

// Program is a compiled CEL expression over the object variable `o`.
type Program struct {
	src string
	prg cel.Program
	out *cel.Type
}

// Error is a compile error. Column is the 0-based position in the source it
// points at, or -1.
type Error struct {
	Src    string
	Msg    string
	Column int
	err    error
}

func (e *Error) Error() string { return fmt.Sprintf("cel %q: %v", e.Src, e.err) }
func (e *Error) Unwrap() error { return e.err }

// Compile compiles a CEL expression; compile errors are *Error.
func Compile(src string) (*Program, error) {
	e, err := celEnv()
	if err != nil {
		return nil, err
	}
	ast, iss := e.Compile(src)
	if iss.Err() != nil {
		ce := &Error{Src: src, Msg: iss.Err().Error(), Column: -1, err: iss.Err()}
		if errs := iss.Errors(); len(errs) > 0 {
			ce.Msg, ce.Column = errs[0].Message, errs[0].Location.Column()
		}
		return nil, ce
	}
	prg, err := e.Program(ast, cel.EvalOptions(cel.OptOptimize), cel.CostLimit(costLimit))
	if err != nil {
		return nil, fmt.Errorf("cel %q: %w", src, err)
	}
	return &Program{src: src, prg: prg, out: ast.OutputType()}, nil
}

// Source returns the expression as compiled.
func (p *Program) Source() string { return p.src }

// OutputType is the static result type ("bool", "int", "dyn" …). Field
// access on `o` is dyn: its type is only known per object.
func (p *Program) OutputType() string { return p.out.String() }

// Eval evaluates against an object. Missing fields yield (nil, nil) so a
// column on a heterogeneous list simply renders empty.
func (p *Program) Eval(obj map[string]any) (any, error) {
	out, _, err := p.prg.Eval(map[string]any{"o": obj})
	if err != nil {
		if strings.Contains(err.Error(), "no such key") {
			return nil, nil
		}
		return nil, err
	}
	return native(out), nil
}

// NotBoolError is a filter result that is neither bool nor missing.
type NotBoolError struct{ Type string }

func (e *NotBoolError) Error() string { return fmt.Sprintf("result is %s, not bool", e.Type) }

// Bool evaluates as a filter. A missing field is false without an error (a
// filter on a heterogeneous list simply doesn't match); a non-bool result is
// false with a *NotBoolError.
func (p *Program) Bool(obj map[string]any) (bool, error) {
	v, err := p.Eval(obj)
	if err != nil || v == nil {
		return false, err
	}
	b, ok := v.(bool)
	if !ok {
		return false, &NotBoolError{Type: typeName(v)}
	}
	return b, nil
}

func typeName(v any) string {
	switch v.(type) {
	case string:
		return "string"
	case int64, uint64:
		return "int"
	case float64:
		return "double"
	case []any:
		return "list"
	case map[string]any:
		return "map"
	}
	return fmt.Sprintf("%T", v)
}

func native(v ref.Val) any {
	switch v.Type() {
	case types.NullType:
		return nil
	case types.IntType, types.UintType, types.DoubleType, types.BoolType, types.StringType:
		return v.Value()
	}
	return v.Value()
}

// Path is a compiled dot path such as metadata.name or spec.containers[0].image.
type Path struct {
	segs []pathSeg
}

type pathSeg struct {
	key   string
	index int // -1 when key is used
}

// CompilePath parses a dot path.
func CompilePath(src string) (*Path, error) {
	p := &Path{}
	for _, part := range strings.Split(src, ".") {
		if part == "" {
			return nil, fmt.Errorf("path %q: empty segment", src)
		}
		key, rest, _ := strings.Cut(part, "[")
		if key != "" {
			p.segs = append(p.segs, pathSeg{key: key, index: -1})
		}
		for rest != "" {
			idx, after, ok := strings.Cut(rest, "]")
			if !ok {
				return nil, fmt.Errorf("path %q: unclosed [", src)
			}
			i, err := strconv.Atoi(idx)
			if err != nil || i < 0 {
				return nil, fmt.Errorf("path %q: bad index %q", src, idx)
			}
			p.segs = append(p.segs, pathSeg{index: i})
			rest = strings.TrimPrefix(after, "[")
		}
	}
	return p, nil
}

// Get returns the value at the path or nil if absent.
func (p *Path) Get(obj map[string]any) any {
	var cur any = obj
	for _, s := range p.segs {
		switch v := cur.(type) {
		case map[string]any:
			if s.index >= 0 {
				return nil
			}
			cur = v[s.key]
		case []any:
			if s.index < 0 || s.index >= len(v) {
				return nil
			}
			cur = v[s.index]
		default:
			return nil
		}
	}
	return cur
}

// sumLib adds list.sum() as known from Kubernetes CEL (k8s.io/apiserver/pkg/cel/library),
// without depending on the apiserver module. Ints sum to int, otherwise to double;
// non-numeric elements yield an error.
func sumLib() cel.EnvOption {
	return cel.Function("sum",
		cel.MemberOverload("list_sum", []*cel.Type{cel.ListType(cel.DynType)}, cel.DynType,
			cel.UnaryBinding(func(v ref.Val) ref.Val {
				l, ok := v.(traits.Lister)
				if !ok {
					return types.NewErr("sum: not a list")
				}
				var isum int64
				var fsum float64
				float := false
				for it := l.Iterator(); it.HasNext() == types.True; {
					switch e := it.Next().(type) {
					case types.Int:
						isum += int64(e)
						fsum += float64(e)
					case types.Uint:
						isum += int64(e)
						fsum += float64(e)
					case types.Double:
						float = true
						fsum += float64(e)
					default:
						return types.NewErr("sum: non-numeric element %v", e.Type())
					}
				}
				if float {
					return types.Double(fsum)
				}
				return types.Int(isum)
			})))
}
