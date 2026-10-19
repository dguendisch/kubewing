package pipeline

import (
	"reflect"
	"testing"
)

func TestParseGrep(t *testing.T) {
	cases := map[string][]GrepTerm{
		"":                 nil,
		"etcd":             {{Text: "etcd"}},
		"Etcd !Completed":  {{Text: "etcd"}, {Text: "completed", Not: true}},
		"  a   b ":         {{Text: "a"}, {Text: "b"}},
		`"api 0" !"x y"`:   {{Text: "api 0"}, {Text: "x y", Not: true}},
		`\!foo a\ b`:       {{Text: "!foo"}, {Text: "a b"}},
		"! a":              {{Text: "a"}},
		"a!b":              {{Text: "a!b"}},
		"!!x":              {{Text: "!x", Not: true}},
		`"unclosed phrase`: {{Text: "unclosed phrase"}},
		`say \"hi\"`:       {{Text: "say"}, {Text: `"hi"`}},
	}
	for in, want := range cases {
		if got := ParseGrep(in); !reflect.DeepEqual(got, want) {
			t.Errorf("ParseGrep(%q) = %+v, want %+v", in, got, want)
		}
	}
}
